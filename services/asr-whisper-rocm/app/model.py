"""Whisper large-v3-turbo engine singleton with async inference queue."""
from __future__ import annotations
import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
import torch
from transformers import pipeline

from .config import settings

logger = logging.getLogger(__name__)


@dataclass
class TranscriptionJob:
    stream_id: int
    user_id: str
    line_id: str
    audio: np.ndarray
    start_ms: int
    end_ms: int
    future: asyncio.Future


class WhisperEngine:
    def __init__(self):
        self.device = settings.device if torch.cuda.is_available() else "cpu"
        if settings.dtype == "float16" and self.device != "cpu":
            torch_dtype = torch.float16
        elif settings.dtype == "bfloat16" and self.device != "cpu":
            torch_dtype = torch.bfloat16
        else:
            torch_dtype = torch.float32

        model_kwargs = {
            "torch_dtype": torch_dtype,
            "low_cpu_mem_usage": True,
            "use_safetensors": True,
            "attn_implementation": "sdpa",
        }

        logger.info("Loading Whisper model %s on %s (dtype=%s)...",
                     settings.model_id, self.device, settings.dtype)
        t0 = time.monotonic()

        self.pipe = pipeline(
            task="automatic-speech-recognition",
            model=settings.model_id,
            torch_dtype=torch_dtype,
            device=self.device,
            model_kwargs=model_kwargs,
            generate_kwargs={
                "language": settings.language,
                "task": settings.task,
            },
        )

        load_s = time.monotonic() - t0
        logger.info("Whisper model loaded in %.1fs", load_s)

        self.queue: asyncio.Queue[TranscriptionJob] = asyncio.Queue(
            maxsize=settings.inference_queue_max
        )
        self._worker_task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._worker_task is None:
            self._worker_task = asyncio.create_task(self._worker())
            logger.info("Inference worker started")

    async def submit(self, job: TranscriptionJob) -> None:
        self.queue.put_nowait(job)

    async def _worker(self) -> None:
        while True:
            job = await self.queue.get()
            try:
                result = await asyncio.to_thread(self._run_one, job.audio)
                if not job.future.done():
                    job.future.set_result(result)
            except Exception as exc:
                logger.exception("Inference failed for stream=%d line=%s",
                                 job.stream_id, job.line_id)
                if not job.future.done():
                    job.future.set_exception(exc)
            finally:
                self.queue.task_done()

    def _run_one(self, audio: np.ndarray) -> dict:
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32, copy=False)

        inp = {"array": audio, "sampling_rate": settings.sample_rate}

        start = time.perf_counter()
        with torch.inference_mode():
            result = self.pipe(inp)
        latency_ms = int((time.perf_counter() - start) * 1000)

        text = (result.get("text") or "").strip()
        text = " ".join(text.split())

        return {"text": text, "latencyMs": latency_ms}


_engine: Optional[WhisperEngine] = None


def get_engine() -> WhisperEngine:
    global _engine
    if _engine is None:
        _engine = WhisperEngine()
    return _engine
