// The Claude side: system prompt, tools, and the tool-use loop.
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import * as db from "./db";
import * as google from "./google";

const SYSTEM_PROMPT = `You are the owner's personal assistant, talking to them over WhatsApp.
Reply in the language the owner writes in (usually Hebrew).
Keep replies short and easy to read on a phone: short lines, no tables or headings.
WhatsApp formatting only: *bold*, _italic_, simple "- " lists.
When the owner asks to be reminded of something, use the set_reminder tool. To change one, use list_reminders and then move_reminder.
Interpret times in the owner's timezone. If a time is ambiguous, pick the sensible one and say which.
Use web search only when the answer depends on current information.
Voice messages from the owner reach you already transcribed to text, starting with the words "הודעה קולית". Treat that text as exactly what the owner said and answer it normally; infer the meaning past small transcription mistakes. Never say you cannot hear voice messages.

You can read the owner's Google Calendar (calendar_events) and add events to it (calendar_add_event).
Before calendar_add_event: check that time with calendar_events, then tell the owner exactly what you will add (title, date, time) and any clash, and ask for a yes. Only add it after they confirm in their next message.
You can read two Google Sheets (read_sheet), read only:
- "work": the "עבודה" sheet. One tab per year (the shoot year), one row per couple: project name, shoot date, stills photographer, venue, production, lead source, notes, songs, editing, status, deposit, price, income, delivery date.
- "tasks": the "ניהול משימות" sheet, tabs "משימות" (tasks) and "הוצאות קבועות" (fixed expenses).
Call read_sheet without a tab first if you are not sure of the tab names. You cannot change the sheets; say so if asked.

How to answer:
- Get all the facts with tools first, check them, and only then write. The reply is sent exactly as you write it, so never write drafts, "wait", second thoughts or corrections inside a reply.
- Say you checked or did something (calendar, sheet, reminder, web) only if a tool call for it succeeded while answering this message. If a tool failed, say it failed.
- If you have no tool for what the owner asks, say so in your first line, and offer what you can do instead.
- Short follow-ups like "את זה", "תכניס את זה" or "גם" refer to what was just discussed. Use that; do not ask what they mean.
- In the history, each of your earlier replies ends with a note in square brackets listing the tools used for it, e.g. [tools: calendar_events]. Trust those notes. Never write such a note yourself, and never apologise for earlier replies unless the owner says something was wrong.`;

const CUSTOM_TOOLS: Anthropic.Tool[] = [
  {
    name: "set_reminder",
    description: "Schedule a WhatsApp message to the owner at a future time.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        when: {
          type: "string",
          description: "ISO 8601 date-time WITH the owner's UTC offset, e.g. 2026-11-26T09:00:00+02:00",
        },
        text: { type: "string", description: "The reminder text to send." },
      },
      required: ["when", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "list_reminders",
    description: "List reminders that have not been sent yet.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "move_reminder",
    description: "Change the time and/or text of a pending reminder.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        when: { type: "string", description: "New ISO 8601 date-time WITH UTC offset" },
        text: { type: "string", description: "New text, or empty string to keep the old text" },
      },
      required: ["id", "when", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a pending reminder by its id.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_events",
    description: "List events in the owner's Google Calendar between two times. Optionally filter by free text.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO 8601 date-time with UTC offset" },
        to: { type: "string", description: "ISO 8601 date-time with UTC offset" },
        query: { type: "string", description: "Free-text filter, or empty string for all events" },
      },
      required: ["from", "to", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_add_event",
    description: "Add an event to the owner's Google Calendar. Only after the owner confirmed the exact details.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 date-time with UTC offset, or YYYY-MM-DD for an all-day event" },
        end: { type: "string", description: "Same format as start. For all-day events, the day AFTER the last day." },
        location: { type: "string", description: "Or empty string" },
        notes: { type: "string", description: "Or empty string" },
      },
      required: ["title", "start", "end", "location", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "read_sheet",
    description: "Read a Google Sheet. Without a tab, returns the tab names. With a tab, returns its rows (numbered).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        sheet: { type: "string", enum: ["work", "tasks"] },
        tab: { type: "string", description: "Tab name, or empty string to list the tabs" },
      },
      required: ["sheet", "tab"],
      additionalProperties: false,
    },
  },
];
const WEB_SEARCH: Anthropic.ToolUnion = { type: "web_search_20250305", name: "web_search", max_uses: 3 };

// ---------- time helpers ----------
export function localParts(env: Env, ms = Date.now()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "long", hourCycle: "h23", timeZoneName: "longOffset",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const offset = (p.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, hour: Number(p.hour), weekday: p.weekday, offset };
}

function fmtLocal(env: Env, ms: number): string {
  const p = localParts(env, ms);
  return `${p.date} ${p.time}`;
}

// ---------- tools ----------
async function runTool(env: Env, name: string, input: any): Promise<string> {
  switch (name) {
    case "set_reminder": {
      if (!/[zZ]|[+-]\d\d:\d\d$/.test(input.when)) throw new Error("'when' must include a UTC offset.");
      const due = Date.parse(input.when);
      if (Number.isNaN(due)) throw new Error("Invalid date.");
      if (due <= Date.now()) throw new Error("That time is in the past.");
      const id = await db.addReminder(env, due, input.text);
      return `Reminder #${id} set for ${fmtLocal(env, due)} (${env.TIMEZONE}).`;
    }
    case "list_reminders": {
      const items = (await db.pendingReminders(env)).map((r) => ({ id: r.id, when: fmtLocal(env, r.due_at), text: r.text }));
      return items.length ? JSON.stringify(items) : "No pending reminders.";
    }
    case "move_reminder": {
      const old = (await db.pendingReminders(env)).find((r) => r.id === input.id);
      if (!old) throw new Error("No such pending reminder.");
      if (!/[zZ]|[+-]\d\d:\d\d$/.test(input.when)) throw new Error("'when' must include a UTC offset.");
      const due = Date.parse(input.when);
      if (Number.isNaN(due) || due <= Date.now()) throw new Error("Invalid or past time.");
      const id = await db.addReminder(env, due, input.text || old.text);
      await db.cancelReminder(env, old.id);
      return `Reminder moved: now #${id} at ${fmtLocal(env, due)}.`;
    }
    case "cancel_reminder":
      return (await db.cancelReminder(env, input.id)) ? "Cancelled." : "No such pending reminder.";
    case "calendar_events":
      return google.listEvents(env, input.from, input.to, input.query || undefined);
    case "calendar_add_event":
      return google.addEvent(env, input);
    case "read_sheet":
      return google.readSheet(env, input.sheet, input.tab || undefined);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- main loop ----------
function systemFor(env: Env): string {
  const p = localParts(env);
  return `${SYSTEM_PROMPT}\n\nCurrent local time: ${p.weekday} ${p.date} ${p.time}, timezone ${env.TIMEZONE} (UTC${p.offset}).`;
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
}

export async function reply(env: Env, userText: string): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  await db.addMessage(env, "user", userText);

  const messages: Anthropic.MessageParam[] = await db.recentMessages(env, Number(env.HISTORY_LIMIT) || 30);
  const system = systemFor(env);
  let tools: Anthropic.ToolUnion[] = [...CUSTOM_TOOLS, WEB_SEARCH];
  let text = "משהו השתבש, נסה שוב.";
  const used = new Set<string>();

  for (let round = 0; round < 8; round++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: env.CLAUDE_MODEL,
        max_tokens: 8000,
        system,
        tools,
        messages,
        output_config: { effort: env.CLAUDE_EFFORT },
      });
    } catch (e) {
      // If this model doesn't accept the web search tool, carry on without it.
      if (e instanceof Anthropic.BadRequestError && tools.includes(WEB_SEARCH)) {
        tools = CUSTOM_TOOLS;
        round--;
        continue;
      }
      throw e;
    }

    if (response.stop_reason === "refusal") {
      text = "מצטער, אני לא יכול לעזור עם זה.";
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue; // long web search; let it continue

    for (const b of response.content) if (b.type === "tool_use" || b.type === "server_tool_use") used.add(b.name);
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      text = textOf(response.content) || "👍";
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      try {
        results.push({ type: "tool_result", tool_use_id: t.id, content: await runTool(env, t.name, t.input) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: t.id, content: `Error: ${(e as Error).message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  text = text.replace(/\s*\[tools:[^\]]*\]\s*$/, "").trim() || "👍";
  // Keep a note of the tools behind this reply, so later turns know it was checked.
  await db.addMessage(env, "assistant", used.size ? `${text}\n\n[tools: ${[...used].join(", ")}]` : text);
  return text;
}

export async function dailyBrief(env: Env): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const today = localParts(env).date;
  const todays = (await db.pendingReminders(env)).filter((r) => localParts(env, r.due_at).date === today);
  let events = "unknown";
  if (google.googleReady(env)) {
    const off = localParts(env).offset;
    events = await google.listEvents(env, `${today}T00:00:00${off}`, `${today}T23:59:59${off}`).catch(() => "unknown");
  }
  const response = await client.messages.create({
    model: env.CLAUDE_MODEL,
    max_tokens: 2000,
    system: systemFor(env),
    messages: [{
      role: "user",
      content: `Write a very short good-morning WhatsApp message for the owner, in Hebrew. Today's reminders: ${
        todays.length ? JSON.stringify(todays.map((r) => `${fmtLocal(env, r.due_at)} ${r.text}`)) : "none"
      }. Today's calendar: ${events}.`,
    }],
    output_config: { effort: "low" },
  });
  if (response.stop_reason === "refusal") return "בוקר טוב!";
  return textOf(response.content) || "בוקר טוב!";
}
