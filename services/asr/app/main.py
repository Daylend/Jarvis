"""
FastAPI application for the ASR sidecar.

Endpoints:
  GET  /healthz          — readiness probe
  WS   /ws/transcribe    — per-session WebSocket (see protocol in plans/transcription_plan.md)
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse

from app import asr as asr_module
from app.session import Session

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
# Enable DEBUG for the stream module so VAD chunk diagnostics are visible
logging.getLogger("app.stream").setLevel(logging.DEBUG)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the ASR model on startup."""
    logger.info("Loading ASR model...")
    asr_module._load_model()
    logger.info("ASR model ready.")
    yield
    logger.info("Shutting down ASR sidecar.")


app = FastAPI(title="PaxFax ASR Sidecar", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> JSONResponse:
    info = asr_module.get_engine_info()
    return JSONResponse({
        "status": "ok" if asr_module.is_loaded() else "loading",
        "engine": info["engine"],
        "model": info["model"],
        "vulkan": info["vulkan"],
    })


@app.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket) -> None:
    await websocket.accept()
    logger.info(f"New WebSocket connection from {websocket.client}")
    session = Session(websocket)
    await session.run()
    logger.info(f"WebSocket connection closed for {websocket.client}")
