// Voice notes -> text, using Whisper on Cloudflare Workers AI.
import { Buffer } from "node:buffer";
import type { Env } from "./env";
import { downloadMedia } from "./whatsapp";

export async function transcribe(env: Env, mediaId: string): Promise<string> {
  const audio = await downloadMedia(env, mediaId);
  const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: Buffer.from(audio).toString("base64"),
    task: "transcribe",
    language: "he",
    vad_filter: true,
  });
  return (result.text ?? "").trim();
}
