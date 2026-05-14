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
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Validate the Moonshine model and manage the shared Transcriber lifecycle.

    A single Transcriber is shared across all WebSocket sessions via
    create_stream(). ONNX Runtime mmaps the .ort file once.
    """
    info = asr_module.get_engine_info()
    if not asr_module.is_loaded():
        logger.error("[lifespan] Moonshine model not found or unreadable; check MOONSHINE_MODEL_PATH.")
    else:
        logger.info("[lifespan] ASR ready: engine=%s model=%s", info["engine"], info["model"])
    yield
    logger.info("Shutting down ASR sidecar.")
    asr_module.shutdown_global_transcriber()


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
