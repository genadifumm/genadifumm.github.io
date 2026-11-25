"""SQLite storage: conversation history, reminders, processed message ids."""
import sqlite3
import threading
from contextlib import contextmanager

from config import DB_PATH

_lock = threading.Lock()


@contextmanager
def _conn():
    with _lock:
        con = sqlite3.connect(DB_PATH)
        con.row_factory = sqlite3.Row
        try:
            yield con
            con.commit()
        finally:
            con.close()


def init_db() -> None:
    with _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL,             -- 'user' | 'assistant'
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                due_at_utc TEXT NOT NULL,       -- ISO 8601, UTC
                text TEXT NOT NULL,
                sent INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS seen_ids (
                wa_id TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS kv (
                k TEXT PRIMARY KEY,
                v TEXT NOT NULL
            );
            """
        )


# --- dedupe (Meta may deliver the same webhook more than once) ---
def mark_seen(wa_message_id: str) -> bool:
    """Return True if this id is new, False if already processed."""
    with _conn() as c:
        cur = c.execute("INSERT OR IGNORE INTO seen_ids (wa_id) VALUES (?)", (wa_message_id,))
        return cur.rowcount == 1


# --- history ---
def add_message(role: str, content: str) -> None:
    with _conn() as c:
        c.execute("INSERT INTO messages (role, content) VALUES (?, ?)", (role, content))


def recent_messages(limit: int) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT role, content FROM messages ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    msgs = [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]
    # The API requires the first message to be from the user.
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


def clear_history() -> None:
    with _conn() as c:
        c.execute("DELETE FROM messages")


# --- reminders ---
def add_reminder(due_at_utc: str, text: str) -> int:
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO reminders (due_at_utc, text) VALUES (?, ?)", (due_at_utc, text)
        )
        return cur.lastrowid


def pending_reminders() -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT id, due_at_utc, text FROM reminders WHERE sent = 0 ORDER BY due_at_utc"
        ).fetchall()
    return [dict(r) for r in rows]


def due_reminders(now_utc_iso: str) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT id, due_at_utc, text FROM reminders WHERE sent = 0 AND due_at_utc <= ?",
            (now_utc_iso,),
        ).fetchall()
    return [dict(r) for r in rows]


def mark_reminder_sent(reminder_id: int) -> None:
    with _conn() as c:
        c.execute("UPDATE reminders SET sent = 1 WHERE id = ?", (reminder_id,))


def cancel_reminder(reminder_id: int) -> bool:
    with _conn() as c:
        cur = c.execute("DELETE FROM reminders WHERE id = ? AND sent = 0", (reminder_id,))
        return cur.rowcount == 1


# --- key/value (last inbound time, last daily brief date) ---
def kv_get(k: str) -> str | None:
    with _conn() as c:
        row = c.execute("SELECT v FROM kv WHERE k = ?", (k,)).fetchone()
    return row["v"] if row else None


def kv_set(k: str, v: str) -> None:
    with _conn() as c:
        c.execute("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", (k, v))
