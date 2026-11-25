"""The Claude side: system prompt, tools, and the tool-use loop."""
import json
import logging
from datetime import datetime, timezone

import anthropic

import storage
from config import CLAUDE_EFFORT, CLAUDE_MODEL, HISTORY_LIMIT, TIMEZONE

log = logging.getLogger(__name__)
client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY

SYSTEM_PROMPT = """You are the owner's personal assistant, talking to them over WhatsApp.
Reply in the language the owner writes in (usually Hebrew).
Keep replies short and easy to read on a phone: short lines, no markdown tables or headings.
WhatsApp formatting only: *bold*, _italic_, simple "- " lists.
When the owner asks to be reminded of something, use the set_reminder tool.
Interpret times in the owner's timezone. If a time is ambiguous, pick the sensible one and say which.
Use web search when the answer depends on current information."""

TOOLS = [
    {
        "name": "set_reminder",
        "description": "Schedule a WhatsApp message to the owner at a future time.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "when": {
                    "type": "string",
                    "description": "Local date-time in ISO 8601 without offset, e.g. 2026-11-26T09:00",
                },
                "text": {"type": "string", "description": "The reminder text to send."},
            },
            "required": ["when", "text"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_reminders",
        "description": "List reminders that have not been sent yet.",
        "strict": True,
        "input_schema": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
    },
    {
        "name": "cancel_reminder",
        "description": "Cancel a pending reminder by its id.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 5},
]


def _now_local() -> datetime:
    return datetime.now(TIMEZONE)


def _run_tool(name: str, args: dict) -> str:
    if name == "set_reminder":
        local = datetime.fromisoformat(args["when"])
        if local.tzinfo is None:
            local = local.replace(tzinfo=TIMEZONE)
        due_utc = local.astimezone(timezone.utc)
        if due_utc <= datetime.now(timezone.utc):
            raise ValueError("That time is in the past.")
        rid = storage.add_reminder(due_utc.isoformat(), args["text"])
        return f"Reminder #{rid} set for {local.strftime('%Y-%m-%d %H:%M')} ({TIMEZONE.key})."
    if name == "list_reminders":
        items = [
            {
                "id": r["id"],
                "when": datetime.fromisoformat(r["due_at_utc"]).astimezone(TIMEZONE).strftime("%Y-%m-%d %H:%M"),
                "text": r["text"],
            }
            for r in storage.pending_reminders()
        ]
        return json.dumps(items, ensure_ascii=False) if items else "No pending reminders."
    if name == "cancel_reminder":
        return "Cancelled." if storage.cancel_reminder(args["id"]) else "No such pending reminder."
    raise ValueError(f"Unknown tool: {name}")


def _call(messages: list) -> anthropic.types.beta.BetaMessage:
    return client.beta.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        tools=TOOLS,
        messages=messages,
        output_config={"effort": CLAUDE_EFFORT},
        # If the model declines on a safety classifier, the API retries on a fallback model.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )


def reply(user_text: str) -> str:
    """Take the owner's message, run Claude (with tools), return the text to send back."""
    storage.add_message("user", user_text)

    # The current time goes in as a mid-conversation system message so the cached
    # system prompt above stays byte-identical between requests.
    messages = storage.recent_messages(HISTORY_LIMIT)
    messages.append({
        "role": "system",
        "content": f"Current local time: {_now_local().strftime('%A %Y-%m-%d %H:%M')} ({TIMEZONE.key}).",
    })

    for _ in range(10):  # safety cap on tool rounds
        response = _call(messages)

        if response.stop_reason == "refusal":
            text = "מצטער, אני לא יכול לעזור עם זה."
            break

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "pause_turn":  # long server-side web search; continue it
            continue

        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if response.stop_reason != "tool_use" or not tool_uses:
            text = "\n".join(b.text for b in response.content if b.type == "text").strip()
            break

        results = []
        for block in tool_uses:
            try:
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": _run_tool(block.name, block.input)})
            except Exception as e:  # report the error back to Claude instead of crashing
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": f"Error: {e}", "is_error": True})
        messages.append({"role": "user", "content": results})
    else:
        text = "משהו השתבש, נסה שוב."

    text = text or "👍"
    storage.add_message("assistant", text)
    return text


def daily_brief() -> str:
    """Short morning message: today's reminders plus a friendly opener."""
    today = _now_local().date()
    todays = [
        r for r in storage.pending_reminders()
        if datetime.fromisoformat(r["due_at_utc"]).astimezone(TIMEZONE).date() == today
    ]
    prompt = (
        "Write a very short good-morning WhatsApp message for the owner (Hebrew). "
        f"Today's reminders: {json.dumps([r['text'] for r in todays], ensure_ascii=False) or 'none'}."
    )
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "low"},
    )
    if response.stop_reason == "refusal":
        return "בוקר טוב!"
    return "\n".join(b.text for b in response.content if b.type == "text").strip() or "בוקר טוב!"
