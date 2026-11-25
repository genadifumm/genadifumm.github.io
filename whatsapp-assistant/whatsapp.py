"""Thin client for the official WhatsApp Cloud API (Meta Graph API)."""
import hashlib
import hmac
import logging
from datetime import datetime, timedelta, timezone

import httpx

import storage
from config import (
    OWNER_PHONE,
    WA_API_VERSION,
    WA_APP_SECRET,
    WA_PHONE_NUMBER_ID,
    WA_TEMPLATE_LANG,
    WA_TEMPLATE_NAME,
    WA_TOKEN,
)

log = logging.getLogger(__name__)
_URL = f"https://graph.facebook.com/{WA_API_VERSION}/{WA_PHONE_NUMBER_ID}/messages"
_HEADERS = {"Authorization": f"Bearer {WA_TOKEN}"}
_MAX_LEN = 4000  # WhatsApp text limit is 4096


def verify_signature(raw_body: bytes, header: str | None) -> bool:
    """Check X-Hub-Signature-256 so only Meta can call the webhook."""
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(WA_APP_SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header.removeprefix("sha256="))


def _post(payload: dict) -> None:
    r = httpx.post(_URL, headers=_HEADERS, json=payload, timeout=30)
    if r.status_code >= 400:
        log.error("WhatsApp API error %s: %s", r.status_code, r.text)
    r.raise_for_status()


def _window_open() -> bool:
    """WhatsApp allows free-form messages only within 24h of the user's last message."""
    last = storage.kv_get("last_inbound_utc")
    if not last:
        return False
    return datetime.now(timezone.utc) - datetime.fromisoformat(last) < timedelta(hours=23, minutes=50)


def _chunks(text: str):
    while text:
        yield text[:_MAX_LEN]
        text = text[_MAX_LEN:]


def send_text(text: str, to: str = OWNER_PHONE) -> None:
    for part in _chunks(text):
        _post({
            "messaging_product": "whatsapp",
            "to": to,
            "type": "text",
            "text": {"body": part, "preview_url": False},
        })


def send_template(text: str, to: str = OWNER_PHONE) -> None:
    _post({
        "messaging_product": "whatsapp",
        "to": to,
        "type": "template",
        "template": {
            "name": WA_TEMPLATE_NAME,
            "language": {"code": WA_TEMPLATE_LANG},
            "components": [{
                "type": "body",
                # Template variables can't contain newlines and are length-limited.
                "parameters": [{"type": "text", "text": " ".join(text.split())[:1000]}],
            }],
        },
    })


def send_proactive(text: str) -> None:
    """Message the owner first: free text if the 24h window is open, otherwise a template."""
    if _window_open():
        send_text(text)
    else:
        send_template(text)


def mark_read(message_id: str) -> None:
    try:
        _post({"messaging_product": "whatsapp", "status": "read", "message_id": message_id})
    except httpx.HTTPError:
        pass  # non-critical
