// Cloudflare Worker: WhatsApp webhook + a cron job for proactive messages.
import type { Env } from "./env";
import * as db from "./db";
import * as wa from "./whatsapp";
import { dailyBrief, localParts, reply } from "./claude";
import { transcribe } from "./voice";

async function handleVoice(env: Env, msgId: string, mediaId: string): Promise<void> {
  let text: string;
  try {
    await wa.markRead(env, msgId);
    text = await transcribe(env, mediaId);
  } catch (e) {
    console.error("transcription failed", e);
    await wa.sendText(env, "⚠️ לא הצלחתי לשמוע את ההקלטה. נסה שוב או כתוב לי.").catch(() => {});
    return;
  }
  if (!text) {
    await wa.sendText(env, "לא שמעתי כלום בהקלטה 🤷").catch(() => {});
    return;
  }
  await wa.sendText(env, `🎤 _${text}_`).catch(() => {}); // show what was heard
  await handleText(env, msgId, `[הודעה קולית] ${text}`, false);
}

async function handleText(env: Env, msgId: string, text: string, markRead = true): Promise<void> {
  try {
    if (markRead) await wa.markRead(env, msgId);
    if (["/reset", "/איפוס"].includes(text.trim())) {
      await db.clearHistory(env);
      await wa.sendText(env, "השיחה אופסה ✅");
      return;
    }
    await wa.sendText(env, await reply(env, text));
  } catch (e) {
    console.error("failed to handle message", e);
    try { await wa.sendText(env, "⚠️ הייתה תקלה, נסה שוב בעוד רגע."); } catch { /* ignore */ }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return Response.json({ ok: true });

    if (url.pathname !== "/webhook") return new Response("Not found", { status: 404 });

    // Meta calls this once when you register the webhook URL.
    if (request.method === "GET") {
      const p = url.searchParams;
      if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === env.WA_VERIFY_TOKEN) {
        return new Response(p.get("hub.challenge") ?? "");
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const raw = await request.text();
    if (!(await wa.verifySignature(env, raw, request.headers.get("X-Hub-Signature-256")))) {
      return new Response("Unauthorized", { status: 401 });
    }

    await db.init(env);
    const body = JSON.parse(raw);
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {
          if (msg.from !== env.OWNER_PHONE) {
            console.warn("ignored message from", msg.from);
            continue;
          }
          if (!(await db.markSeen(env, msg.id))) continue; // duplicate delivery
          await db.kvSet(env, "last_inbound_ms", String(Date.now()));

          // Answer Meta right away; the reply is sent in the background.
          if (msg.type === "text") {
            ctx.waitUntil(handleText(env, msg.id, msg.text.body));
          } else if (msg.type === "audio") {
            ctx.waitUntil(handleVoice(env, msg.id, msg.audio.id));
          } else {
            ctx.waitUntil(wa.sendText(env, "כרגע אני מבין טקסט והודעות קוליות 🙂").catch(console.error));
          }
        }
      }
    }
    return Response.json({ ok: true });
  },

  // Runs every minute (see wrangler.toml).
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await db.init(env);

    for (const r of await db.dueReminders(env, Date.now())) {
      try {
        await wa.sendProactive(env, `⏰ תזכורת: ${r.text}`);
        await db.markReminderSent(env, r.id);
        await db.addMessage(env, "assistant", `(sent reminder) ${r.text}`);
      } catch (e) {
        console.error("reminder failed", r.id, e);
      }
    }

    if (env.DAILY_BRIEF_HOUR) {
      const now = localParts(env);
      if (now.hour >= Number(env.DAILY_BRIEF_HOUR) && (await db.kvGet(env, "last_brief")) !== now.date) {
        await db.kvSet(env, "last_brief", now.date);
        try {
          const text = await dailyBrief(env);
          await wa.sendProactive(env, text);
          await db.addMessage(env, "assistant", text);
        } catch (e) {
          console.error("daily brief failed", e);
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;
