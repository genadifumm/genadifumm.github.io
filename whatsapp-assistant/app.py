"""Web server: WhatsApp webhook + background scheduler for proactive messages."""
import logging
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse

import assistant
import storage
import whatsapp
from config import DAILY_BRIEF_HOUR, OWNER_PHONE, TIMEZONE, WA_VERIFY_TOKEN

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")


# ---------- proactive messages ----------
def _scheduler_loop() -> None:
    while True:
        try:
            now_utc = datetime.now(timezone.utc)
            for r in storage.due_reminders(now_utc.isoformat()):
                whatsapp.send_proactive(f"⏰ תזכורת: {r['text']}")
                storage.mark_reminder_sent(r["id"])
                storage.add_message("assistant", f"(sent reminder) {r['text']}")

            if DAILY_BRIEF_HOUR:
                now_local = now_utc.astimezone(TIMEZONE)
                today = now_local.date().isoformat()
                if now_local.hour >= int(DAILY_BRIEF_HOUR) and storage.kv_get("last_brief") != today:
                    storage.kv_set("last_brief", today)
                    text = assistant.daily_brief()
                    whatsapp.send_proactive(text)
                    storage.add_message("assistant", text)
        except Exception:
            log.exception("scheduler error")
        time.sleep(30)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    storage.init_db()
    threading.Thread(target=_scheduler_loop, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True}


# ---------- webhook ----------
@app.get("/webhook")
def verify(request: Request):
    """Meta calls this once when you register the webhook URL."""
    p = request.query_params
    if p.get("hub.mode") == "subscribe" and p.get("hub.verify_token") == WA_VERIFY_TOKEN:
        return PlainTextResponse(p.get("hub.challenge", ""))
    raise HTTPException(status_code=403)


def _handle(msg_id: str, text: str) -> None:
    try:
        whatsapp.mark_read(msg_id)
        if text.strip() in ("/reset", "/איפוס"):
            storage.clear_history()
            whatsapp.send_text("השיחה אופסה ✅")
            return
        whatsapp.send_text(assistant.reply(text))
    except Exception:
        log.exception("failed to handle message")
        try:
            whatsapp.send_text("⚠️ הייתה תקלה, נסה שוב בעוד רגע.")
        except Exception:
            log.exception("failed to send error notice")


@app.post("/webhook")
async def receive(request: Request, background: BackgroundTasks):
    raw = await request.body()
    if not whatsapp.verify_signature(raw, request.headers.get("X-Hub-Signature-256")):
        raise HTTPException(status_code=401)

    body = await request.json()
    for entry in body.get("entry", []):
        for change in entry.get("changes", []):
            for msg in change.get("value", {}).get("messages", []):
                if msg.get("from") != OWNER_PHONE:
                    log.warning("ignored message from %s", msg.get("from"))
                    continue
                if not storage.mark_seen(msg["id"]):
                    continue  # duplicate delivery
                storage.kv_set("last_inbound_utc", datetime.now(timezone.utc).isoformat())

                if msg.get("type") == "text":
                    background.add_task(_handle, msg["id"], msg["text"]["body"])
                else:
                    background.add_task(whatsapp.send_text, "כרגע אני מבין רק הודעות טקסט 🙂")

    # Answer Meta fast; the reply is sent in the background.
    return {"ok": True}
