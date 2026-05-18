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


class VoiceRequest(BaseModel):
    name: str = Field(
        ..., min_length=1, max_length=255, description="Voice sample filename"
    )


class SpeedRequest(BaseModel):
    speed: float = Field(
        ..., ge=0.5, le=2.0, description="Speech speed multiplier (0.5–2.0)"
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


AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus"}


@app.get("/voices")
async def list_voices():
    voices_dir = "/app/voice_samples"
    voices: list[str] = []
    if os.path.isdir(voices_dir):
        for entry in sorted(os.listdir(voices_dir)):
            _, ext = os.path.splitext(entry)
            if ext.lower() in AUDIO_EXTENSIONS:
                voices.append(entry)
    return {
        "current": tts_model.get_current_voice(),
        "voices": voices,
    }


@app.post("/voice")
async def set_voice(req: VoiceRequest):
    if not tts_model.is_loaded():
        raise HTTPException(status_code=503, detail="Model not yet loaded")

    voice_path = os.path.join("/app/voice_samples", req.name)
    real = os.path.realpath(voice_path)
    if not real.startswith(os.path.realpath("/app/voice_samples") + os.sep) and real != os.path.realpath("/app/voice_samples"):
        raise HTTPException(status_code=400, detail="Invalid voice path")

    if not os.path.isfile(real):
        raise HTTPException(status_code=404, detail=f"Voice sample not found: {req.name}")

    try:
        tts_model.set_ref_audio(real)
    except Exception as e:
        logger.exception("Failed to switch voice to %s", req.name)
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "ok", "voice": tts_model.get_current_voice(), "transcript": tts_model.REF_TEXT}


@app.get("/speed")
async def get_speed():
    return {"speed": tts_model.get_speed()}


@app.post("/speed")
async def set_speed(req: SpeedRequest):
    new_speed = tts_model.set_speed(req.speed)
    return {"speed": new_speed}


if __name__ == "__main__":
    port = int(os.getenv("TTS_PORT", "8860"))
    uvicorn.run(app, host="0.0.0.0", port=port)
