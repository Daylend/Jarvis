"""Granite STT engine via llama-cpp OpenAI-compatible HTTP endpoint."""
from __future__ import annotations
import asyncio
import io
import logging
import time

import httpx
import numpy as np
import soundfile as sf

from ..config import settings
from .base import Engine

logger = logging.getLogger(__name__)


class GraniteEngine(Engine):
    label = "granite-speech"

    def __init__(self):
        self._client: httpx.AsyncClient | None = None
        self._sem = asyncio.Semaphore(settings.granite_max_concurrency)

    async def start(self) -> None:
        self._client = httpx.AsyncClient(timeout=settings.granite_timeout_s)
        logger.info(
            "Granite engine ready — endpoint=%s model=%s concurrency=%d",
            settings.openai_base_url, settings.granite_model,
            settings.granite_max_concurrency,
        )

    async def transcribe(self, audio: np.ndarray, sample_rate: int) -> dict:
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32, copy=False)

        buf = io.BytesIO()
        sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
        buf.seek(0)

        url = f"{settings.openai_base_url.rstrip('/')}/audio/transcriptions"
        files = {"file": ("audio.wav", buf, "audio/wav")}
        data = {"model": settings.granite_model, "prompt": settings.granite_prompt}

        t0 = time.perf_counter()
        async with self._sem:
            resp = await self._client.post(url, files=files, data=data)
            resp.raise_for_status()
        latency_ms = int((time.perf_counter() - t0) * 1000)

        text = " ".join((resp.json().get("text") or "").split())
        return {"text": text, "latencyMs": latency_ms}

    def health(self) -> dict:
        return {
            "engine": "granite",
            "model": settings.granite_model,
            "url": settings.openai_base_url,
        }

    def ready_payload(self) -> dict:
        return {
            "engine": "granite",
            "model": settings.granite_model,
            "vulkan": False,
        }