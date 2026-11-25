// D1 (SQLite) storage. Tables are created on first use, so no migration step is needed.
import type { Env } from "./env";

let ready = false;

export async function init(env: Env): Promise<void> {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      due_at INTEGER NOT NULL,          -- unix ms, UTC
      text TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS seen_ids (wa_id TEXT PRIMARY KEY)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
  ]);
  ready = true;
}

/** True if this WhatsApp message id is new (Meta can deliver the same webhook twice). */
export async function markSeen(env: Env, waId: string): Promise<boolean> {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO seen_ids (wa_id) VALUES (?)").bind(waId).run();
  return r.meta.changes === 1;
}

export type Msg = { role: "user" | "assistant"; content: string };

export async function addMessage(env: Env, role: Msg["role"], content: string): Promise<void> {
  await env.DB.prepare("INSERT INTO messages (role, content) VALUES (?, ?)").bind(role, content).run();
}

export async function recentMessages(env: Env, limit: number): Promise<Msg[]> {
  const { results } = await env.DB
    .prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<Msg>();
  const msgs = results.reverse();
  while (msgs.length && msgs[0].role !== "user") msgs.shift(); // API needs a user turn first
  return msgs;
}

export async function clearHistory(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM messages").run();
}

export type Reminder = { id: number; due_at: number; text: string };

export async function addReminder(env: Env, dueAt: number, text: string): Promise<number> {
  const r = await env.DB.prepare("INSERT INTO reminders (due_at, text) VALUES (?, ?)").bind(dueAt, text).run();
  return r.meta.last_row_id;
}

export async function pendingReminders(env: Env): Promise<Reminder[]> {
  const { results } = await env.DB
    .prepare("SELECT id, due_at, text FROM reminders WHERE sent = 0 ORDER BY due_at")
    .all<Reminder>();
  return results;
}

export async function dueReminders(env: Env, now: number): Promise<Reminder[]> {
  const { results } = await env.DB
    .prepare("SELECT id, due_at, text FROM reminders WHERE sent = 0 AND due_at <= ?")
    .bind(now)
    .all<Reminder>();
  return results;
}

export async function markReminderSent(env: Env, id: number): Promise<void> {
  await env.DB.prepare("UPDATE reminders SET sent = 1 WHERE id = ?").bind(id).run();
}

export async function cancelReminder(env: Env, id: number): Promise<boolean> {
  const r = await env.DB.prepare("DELETE FROM reminders WHERE id = ? AND sent = 0").bind(id).run();
  return r.meta.changes === 1;
}

export async function kvGet(env: Env, k: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first<{ v: string }>();
  return row?.v ?? null;
}

export async function kvSet(env: Env, k: string, v: string): Promise<void> {
  await env.DB
    .prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(k, v)
    .run();
}
