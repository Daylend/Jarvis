import logging
import os

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.config import TTS_PORT
from app import model as tts_model

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="PaxFax F5-TTS Sidecar")


class TtsRequest(BaseModel):
    text: str = Field(
        ..., min_length=1, max_length=1000, description="Text to speak"
    )


@app.on_event("startup")
async def startup():
    logger.info("Pre-loading F5-TTS model...")
    try:
        tts_model._ensure_loaded()
        info = tts_model.get_engine_info()
        logger.info(
            "TTS ready: engine=%s model=%s device=%s",
            info["engine"],
            info["model"],
            info["device"],
        )
    except Exception:
        logger.exception(
            "Failed to pre-load F5-TTS model — will retry on first request"
        )


@app.get("/healthz")
async def healthz():
    info = tts_model.get_engine_info()
    return {
        "status": "ok" if tts_model.is_loaded() else "loading",
        "engine": info["engine"],
        "model": info["model"],
        "device": info["device"],
    }


@app.post("/tts")
async def tts(req: TtsRequest):
    if not tts_model.is_loaded():
        raise HTTPException(status_code=503, detail="Model not yet loaded")

    try:
        wav_bytes, duration_ms = tts_model.synthesize(req.text)
    except Exception as e:
        logger.exception("TTS synthesis failed for text=%r", req.text[:80])
        raise HTTPException(status_code=500, detail=str(e))

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Inference-Ms": str(round(duration_ms)),
            "X-Text-Length": str(len(req.text)),
        },
    )


if __name__ == "__main__":
    port = int(os.getenv("TTS_PORT", "8860"))
    uvicorn.run(app, host="0.0.0.0", port=port)
