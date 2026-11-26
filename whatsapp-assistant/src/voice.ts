// Voice notes -> text, using Whisper on Cloudflare Workers AI.
import { Buffer } from "node:buffer";
import type { Env } from "./env";
import { downloadMedia } from "./whatsapp";

// A Hebrew hint keeps Whisper in Hebrew and helps it spell common words.
const HINT = "הודעה קולית בעברית מגנאדי לעוזר האישי שלו: תזכורות, פגישות, צילומי חתונות, זוגות וספקים.";

export async function transcribe(env: Env, mediaId: string): Promise<string> {
  const audio = await downloadMedia(env, mediaId);
  const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: Buffer.from(audio).toString("base64"),
    task: "transcribe",
    language: "he",
    initial_prompt: HINT,
    condition_on_previous_text: false,
  });
  return (result.text ?? "").trim();
}
