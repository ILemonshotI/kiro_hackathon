from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

# Load AWS keys from .env if present; otherwise boto3 uses its default chain.
load_dotenv()

app = FastAPI()


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass


# Mounted last so /ws takes precedence.
app.mount("/", StaticFiles(directory="public", html=True), name="public")
