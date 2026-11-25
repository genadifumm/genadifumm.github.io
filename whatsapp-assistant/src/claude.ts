// The Claude side: system prompt, tools, and the tool-use loop.
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import * as db from "./db";

const SYSTEM_PROMPT = `You are the owner's personal assistant, talking to them over WhatsApp.
Reply in the language the owner writes in (usually Hebrew).
Keep replies short and easy to read on a phone: short lines, no tables or headings.
WhatsApp formatting only: *bold*, _italic_, simple "- " lists.
When the owner asks to be reminded of something, use the set_reminder tool.
Interpret times in the owner's timezone. If a time is ambiguous, pick the sensible one and say which.
Use web search only when the answer depends on current information.`;

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
    case "cancel_reminder":
      return (await db.cancelReminder(env, input.id)) ? "Cancelled." : "No such pending reminder.";
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

  await db.addMessage(env, "assistant", text);
  return text;
}

export async function dailyBrief(env: Env): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const today = localParts(env).date;
  const todays = (await db.pendingReminders(env)).filter((r) => localParts(env, r.due_at).date === today);
  const response = await client.messages.create({
    model: env.CLAUDE_MODEL,
    max_tokens: 2000,
    system: systemFor(env),
    messages: [{
      role: "user",
      content: `Write a very short good-morning WhatsApp message for the owner, in Hebrew. Today's reminders: ${
        todays.length ? JSON.stringify(todays.map((r) => `${fmtLocal(env, r.due_at)} ${r.text}`)) : "none"
      }.`,
    }],
    output_config: { effort: "low" },
  });
  if (response.stop_reason === "refusal") return "בוקר טוב!";
  return textOf(response.content) || "בוקר טוב!";
}
