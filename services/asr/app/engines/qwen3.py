"""Qwen3-ASR engine via llama-cpp OpenAI-compatible HTTP endpoint.

Shares the same llama-cpp instance/endpoint as Granite. Differences:
  - No instruction `prompt` field (sending one injects text into the user turn and
    corrupts the chat template).
  - No `language` field (stock llama-cpp cannot place Qwen3-ASR's required decoder-side
    suffix after the generation prompt, so no server-side forcing; parse-only).
  - Raw generation carries a `language <X><asr_text>` marker that the engine strips
    before returning the transcript text.
"""
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

_ASR_TEXT_TAG = "<asr_text>"


def _parse_qwen3_raw(raw: str) -> str:
    """Strip Qwen3-ASR's `language <X><asr_text>` marker from raw output.

    Handles:
      - `language English<asr_text>your transcript` -> `your transcript`
      - `language None<asr_text>` (silent audio) -> `""`
      - no tag -> treat the whole string as text (defensive fallback)
    Whitespace is collapsed to match Granite's `" ".join(...split())` normalization.
    """
    if not raw:
        return ""
    s = raw.strip()
    if _ASR_TEXT_TAG in s:
        meta, _, text = s.partition(_ASR_TEXT_TAG)
        if "language none" in meta.lower():
            return " ".join(text.split())
        return " ".join(text.split())
    return " ".join(s.split())


class Qwen3Engine(Engine):
    label = "qwen3-asr"

    def __init__(self):
        self._client: httpx.AsyncClient | None = None
        self._sem = asyncio.Semaphore(settings.qwen3_max_concurrency)

    async def start(self) -> None:
        self._client = httpx.AsyncClient(timeout=settings.qwen3_timeout_s)
        logger.info(
            "Qwen3-ASR engine ready — endpoint=%s model=%s concurrency=%d",
            settings.openai_base_url, settings.qwen3_model,
            settings.qwen3_max_concurrency,
        )

    async def transcribe(self, audio: np.ndarray, sample_rate: int) -> dict:
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32, copy=False)

        buf = io.BytesIO()
        sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
        buf.seek(0)

        url = f"{settings.openai_base_url.rstrip('/')}/audio/transcriptions"
        files = {"file": ("audio.wav", buf, "audio/wav")}
        # No `prompt` (would corrupt the chat template) and no `language` (no forcing;
        # parse-only). The model emits a `language <X><asr_text>` marker we strip below.
        data = {"model": settings.qwen3_model}

        t0 = time.perf_counter()
        async with self._sem:
            resp = await self._client.post(url, files=files, data=data)
            resp.raise_for_status()
        latency_ms = int((time.perf_counter() - t0) * 1000)

        raw_text = resp.json().get("text") or ""
        text = _parse_qwen3_raw(raw_text)
        return {"text": text, "latencyMs": latency_ms}

    def health(self) -> dict:
        return {
            "engine": "qwen3",
            "model": settings.qwen3_model,
            "url": settings.openai_base_url,
        }

    def ready_payload(self) -> dict:
        return {
            "engine": "qwen3",
            "model": settings.qwen3_model,
            "vulkan": False,
        }
