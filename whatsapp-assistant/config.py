"""All settings come from environment variables (see .env.example)."""
import os
from zoneinfo import ZoneInfo


def _req(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


# Anthropic (the SDK reads ANTHROPIC_API_KEY itself)
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
CLAUDE_EFFORT = os.environ.get("CLAUDE_EFFORT", "medium")  # low | medium | high

# WhatsApp Cloud API (Meta)
WA_TOKEN = _req("WA_TOKEN")                      # permanent System User access token
WA_PHONE_NUMBER_ID = _req("WA_PHONE_NUMBER_ID")  # the bot's phone number id
WA_APP_SECRET = _req("WA_APP_SECRET")            # used to verify webhook signatures
WA_VERIFY_TOKEN = _req("WA_VERIFY_TOKEN")        # any random string you choose
WA_API_VERSION = os.environ.get("WA_API_VERSION", "v23.0")

# Only this number may talk to the assistant (international format, digits only)
OWNER_PHONE = _req("OWNER_PHONE")

# Approved message template used when the 24h customer-service window is closed.
# Must have exactly one body variable: {{1}}.
WA_TEMPLATE_NAME = os.environ.get("WA_TEMPLATE_NAME", "assistant_notification")
WA_TEMPLATE_LANG = os.environ.get("WA_TEMPLATE_LANG", "he")

# Behaviour
TIMEZONE = ZoneInfo(os.environ.get("TIMEZONE", "Asia/Jerusalem"))
HISTORY_LIMIT = int(os.environ.get("HISTORY_LIMIT", "40"))
DAILY_BRIEF_HOUR = os.environ.get("DAILY_BRIEF_HOUR", "")  # e.g. "8" to enable, empty = off
DB_PATH = os.environ.get("DB_PATH", "assistant.db")
