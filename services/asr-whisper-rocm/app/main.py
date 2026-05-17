"""FastAPI application for the Whisper ROCm ASR sidecar."""
import logging
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse

from .config import settings
from .model import get_engine
from .session import AsrSession

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine = get_engine()
    engine.start()
    logger.info("[lifespan] ASR ready: model=%s device=%s", settings.model_id, settings.device)
    yield
    logger.info("Shutting down ASR sidecar.")


app = FastAPI(title="PaxFax ASR Sidecar (Whisper ROCm)", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> JSONResponse:
    cuda_available = torch.cuda.is_available()
    engine = get_engine()
    return JSONResponse({
        "ok": True,
        "engine": "whisper-transformers-rocm",
        "model": settings.model_id,
        "device": settings.device,
        "torch": torch.__version__,
        "hip": getattr(torch.version, "hip", None),
        "cudaAvailable": cuda_available,
        "gpuCount": torch.cuda.device_count() if cuda_available else 0,
        "gpuName": torch.cuda.get_device_name(0) if cuda_available else None,
        "partials": settings.enable_partials,
        "sampleRate": settings.sample_rate,
        "queueDepth": engine.queue.qsize(),
    })


@app.websocket("/ws/transcribe")
async def transcribe_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    logger.info("New WebSocket connection from %s", websocket.client)
    session = AsrSession(websocket)
    await session.run()
    logger.info("WebSocket connection closed for %s", websocket.client)
