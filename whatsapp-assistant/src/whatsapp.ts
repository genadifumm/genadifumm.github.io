// Thin client for the official WhatsApp Cloud API (Meta Graph API).
import type { Env } from "./env";
import { kvGet } from "./db";

const MAX_LEN = 4000; // WhatsApp text limit is 4096

/** Check X-Hub-Signature-256 so only Meta can call the webhook. */
export async function verifySignature(env: Env, rawBody: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.WA_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const hex = header.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const sig = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(rawBody));
}

async function post(env: Env, payload: unknown): Promise<void> {
  const url = `https://graph.facebook.com/${env.WA_API_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`WhatsApp API ${r.status}: ${await r.text()}`);
}

export async function sendText(env: Env, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += MAX_LEN) {
    await post(env, {
      messaging_product: "whatsapp",
      to: env.OWNER_PHONE,
      type: "text",
      text: { body: text.slice(i, i + MAX_LEN), preview_url: false },
    });
  }
}

async function sendTemplate(env: Env, text: string): Promise<void> {
  await post(env, {
    messaging_product: "whatsapp",
    to: env.OWNER_PHONE,
    type: "template",
    template: {
      name: env.WA_TEMPLATE_NAME,
      language: { code: env.WA_TEMPLATE_LANG },
      components: [{
        type: "body",
        // template variables can't contain newlines
        parameters: [{ type: "text", text: text.replace(/\s+/g, " ").slice(0, 1000) }],
      }],
    },
  });
}

/** Message the owner first. Free text works only within 24h of their last message; otherwise a template. */
export async function sendProactive(env: Env, text: string): Promise<void> {
  const last = Number(await kvGet(env, "last_inbound_ms") ?? 0);
  const windowOpen = Date.now() - last < (23 * 60 + 50) * 60 * 1000;
  await (windowOpen ? sendText(env, text) : sendTemplate(env, text));
}

export async function markRead(env: Env, messageId: string): Promise<void> {
  try {
    await post(env, { messaging_product: "whatsapp", status: "read", message_id: messageId });
  } catch { /* non-critical */ }
}
