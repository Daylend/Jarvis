"""FastAPI application for the ASR sidecar."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse

from .config import settings
from .engines import get_engine
from .session import AsrSession

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine = get_engine()
    await engine.start()
    logger.info("[lifespan] ASR ready: engine=%s", settings.engine)
    yield
    logger.info("Shutting down ASR sidecar.")


app = FastAPI(title="PaxFax ASR Sidecar", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "sampleRate": settings.sample_rate,
        "partials": settings.enable_partials,
        **get_engine().health(),
    })


@app.websocket("/ws/transcribe")
async def transcribe_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    logger.info("New WebSocket connection from %s", websocket.client)
    session = AsrSession(websocket)
    await session.run()
    logger.info("WebSocket connection closed for %s", websocket.client)
