"""Whisper large-v3-turbo engine with async inference queue."""
from __future__ import annotations
import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
import torch
from transformers import pipeline

from ..config import settings
from .base import Engine

logger = logging.getLogger(__name__)


@dataclass
class _TranscriptionJob:
    audio: np.ndarray
    future: asyncio.Future


class WhisperEngine(Engine):
    label: str

    def __init__(self):
        self.label = settings.model_id
        self.device = settings.device if torch.cuda.is_available() else "cpu"
        if settings.dtype == "float16" and self.device != "cpu":
            torch_dtype = torch.float16
        elif settings.dtype == "bfloat16" and self.device != "cpu":
            torch_dtype = torch.bfloat16
        else:
            torch_dtype = torch.float32

        model_kwargs = {
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

        self.queue: asyncio.Queue[_TranscriptionJob] = asyncio.Queue(
            maxsize=settings.inference_queue_max
        )
        self._worker_task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        if self._worker_task is None:
            self._worker_task = asyncio.create_task(self._worker())
            logger.info("Inference worker started")

    async def transcribe(self, audio: np.ndarray, sample_rate: int) -> dict:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        job = _TranscriptionJob(audio=audio, future=fut)
        await self.queue.put(job)
        return await fut

    async def _worker(self) -> None:
        try:
            while True:
                job = await self.queue.get()
                try:
                    result = await asyncio.to_thread(self._run_one, job.audio)
                    if not job.future.done():
                        job.future.set_result(result)
                except Exception as exc:
                    logger.exception("Inference failed")
                    if not job.future.done():
                        job.future.set_exception(exc)
                finally:
                    self.queue.task_done()
        except asyncio.CancelledError:
            logger.info("Inference worker shutting down")
            raise

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

    def health(self) -> dict:
        cuda_available = torch.cuda.is_available()
        return {
            "engine": "whisper-transformers-rocm",
            "model": settings.model_id,
            "device": settings.device,
            "torch": torch.__version__,
            "hip": getattr(torch.version, "hip", None),
            "cudaAvailable": cuda_available,
            "gpuCount": torch.cuda.device_count() if cuda_available else 0,
            "gpuName": torch.cuda.get_device_name(0) if cuda_available else None,
            "queueDepth": self.queue.qsize(),
        }

    def ready_payload(self) -> dict:
        return {
            "engine": "whisper-transformers-rocm",
            "model": settings.model_id,
            "vulkan": False,
        }