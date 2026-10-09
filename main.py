import asyncio
import base64
import json
import logging
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from langchain_core.messages import AIMessage

# Load AWS keys from .env if present; otherwise boto3 uses its default chain.
load_dotenv()

import agent  # noqa: E402  (after load_dotenv so boto3 sees the keys)
import speech  # noqa: E402

log = logging.getLogger("uvicorn.error")

CHARACTER = agent.CHARACTER
VOICE = CHARACTER.get("voice", "Matthew")
MAX_CHARS = 500
FALLBACK_LINE = (
    "Whoa, friend, I think I just curdled for a second. "
    "Give me a moment and ask me that again!"
)
ERROR_MESSAGE = "Oops, something went wrong on my side. Please try again."


def _config_message() -> dict:
    # Never send the personality to the browser.
    return {
        "type": "config",
        "name": CHARACTER["name"],
        "avatar": CHARACTER["avatar"],
        "background": CHARACTER["background"],
        "moves": [m["name"] for m in CHARACTER.get("moves", []) if "name" in m],
    }


async def _reply_message(text: str, emotion: str, fallback: bool = False) -> dict:
    """Synthesize `text` with Polly; on Polly failure the reply is sent without audio."""
    audio, visemes = None, []
    try:
        mp3, marks = await asyncio.to_thread(speech.synthesize, text, VOICE)
        audio = base64.b64encode(mp3).decode("ascii")
        visemes = [{"time": m["time"], "value": m["value"]} for m in marks if m.get("type") == "viseme"]
    except Exception as exc:  # noqa: BLE001
        log.warning("Polly failed, sending text only: %s", type(exc).__name__)
    return {
        "type": "reply",
        "text": text,
        "emotion": emotion,
        "move": "none",
        "audio": audio,
        "visemes": visemes,
        "fallback": fallback,
    }


async def _greet(thread_id: str) -> dict:
    """Fixed greeting (no LLM call), stored as the first AI message of the thread."""
    greeting = CHARACTER["greeting"]
    await asyncio.to_thread(
        agent.graph.update_state,
        {"configurable": {"thread_id": thread_id}},
        {"messages": [AIMessage(greeting)], "emotion": "happy"},
        as_node="answer",
    )
    return await _reply_message(greeting, "happy")


async def _chat(text: str, thread_id: str) -> dict:
    try:
        # Sync graph call in a thread so the event loop (and WebSocket) stays responsive.
        reply = await asyncio.to_thread(agent.ask_sync, text, thread_id)
        return await _reply_message(reply.text, reply.emotion)
    except Exception as exc:  # noqa: BLE001
        log.warning("Bedrock failed, using fallback line: %s", type(exc).__name__)
        return await _reply_message(FALLBACK_LINE, "sad", fallback=True)


app = FastAPI()


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    thread_id = str(uuid.uuid4())  # one conversation per WebSocket
    greeted = False
    try:
        await websocket.send_json(_config_message())
        # Messages are handled one at a time: the next one is read only after the reply is sent.
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("text") is None:
                continue  # binary frames are for bonus A (mic), ignored for now
            try:
                data = json.loads(message["text"])
                kind = data.get("type")
                if kind == "start":
                    if greeted:
                        continue
                    greeted = True
                    await websocket.send_json(await _greet(thread_id))
                elif kind == "chat":
                    text = str(data.get("text", "")).strip()[:MAX_CHARS]
                    if not text:
                        await websocket.send_json({"type": "error", "message": "Type a message first, friend!"})
                        continue
                    await websocket.send_json({"type": "thinking"})
                    await websocket.send_json(await _chat(text, thread_id))
            except (WebSocketDisconnect, RuntimeError):
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("WebSocket request failed: %s", type(exc).__name__)
                await websocket.send_json({"type": "error", "message": ERROR_MESSAGE})
    except (WebSocketDisconnect, RuntimeError):
        pass


# Mounted last so /ws takes precedence.
app.mount("/", StaticFiles(directory="public", html=True), name="public")
