"""Per-user audio stream: ring buffer, VAD, inference submission."""
from __future__ import annotations
import asyncio
import logging
from typing import Optional

import numpy as np

from .config import settings
from .model import TranscriptionJob, get_engine
from .vad import VadState, Segment

logger = logging.getLogger(__name__)

SAMPLE_RATE = settings.sample_rate


def pcm_s16le_to_float32(pcm: bytes) -> np.ndarray:
    if len(pcm) == 0:
        return np.empty(0, dtype=np.float32)
    if len(pcm) % 2 != 0:
        pcm = pcm[: len(pcm) - 1]
    audio_i16 = np.frombuffer(pcm, dtype="<i2")
    return audio_i16.astype(np.float32) / 32768.0


class RingBuffer:
    def __init__(self, max_samples: int):
        self._buf = np.zeros(max_samples, dtype=np.float32)
        self._capacity = max_samples
        self._write_pos = 0
        self._start_pos = 0

    @property
    def write_pos(self) -> int:
        return self._write_pos

    def append(self, audio: np.ndarray) -> None:
        n = len(audio)
        if n == 0:
            return
        if n > self._capacity:
            audio = audio[-self._capacity:]
            n = self._capacity

        offset = self._write_pos % self._capacity
        space = self._capacity - offset

        if n <= space:
            self._buf[offset : offset + n] = audio
        else:
            self._buf[offset:] = audio[:space]
            self._buf[: n - space] = audio[space:]

        self._write_pos += n
        if self._write_pos - self._start_pos > self._capacity:
            self._start_pos = self._write_pos - self._capacity

    def slice(self, start_sample: int, end_sample: int) -> np.ndarray:
        start_sample = max(start_sample, self._start_pos)
        end_sample = min(end_sample, self._write_pos)
        if end_sample <= start_sample:
            return np.empty(0, dtype=np.float32)

        n = end_sample - start_sample
        offset = start_sample % self._capacity
        space = self._capacity - offset

        if n <= space:
            return self._buf[offset : offset + n].copy()
        else:
            return np.concatenate([
                self._buf[offset:],
                self._buf[: n - space],
            ])


class StreamState:
    def __init__(self, stream_id: int, user_id: str):
        self.stream_id = stream_id
        self.user_id = user_id
        self.samples_seen: int = 0
        self.line_seq: int = 0

        max_samples = int(settings.max_buffer_s * SAMPLE_RATE)
        self.ring = RingBuffer(max_samples)
        self.vad = VadState(stream_id)

    async def accept_pcm(self, pcm_bytes: bytes) -> list[dict]:
        audio = pcm_s16le_to_float32(pcm_bytes)
        if len(audio) == 0:
            return []

        abs_start = self.samples_seen
        self.ring.append(audio)
        self.samples_seen += len(audio)

        segments = self.vad.accept(audio, abs_start)

        events: list[dict] = []
        for seg in segments:
            event = await self._finalize_segment(seg)
            if event is not None:
                events.append(event)

        return events

    async def flush(self) -> list[dict]:
        seg = self.vad.flush()
        if seg is None:
            return []
        event = await self._finalize_segment(seg)
        return [event] if event else []

    async def _finalize_segment(self, seg: Segment) -> Optional[dict]:
        audio = self.ring.slice(seg.start_sample, seg.end_sample)
        duration_ms = len(audio) * 1000 / SAMPLE_RATE

        if duration_ms < settings.min_final_audio_ms:
            logger.debug("[stream %d] segment too short (%.0fms), skipping",
                         self.stream_id, duration_ms)
            return None

        line_id = f"{self.stream_id}:{self.line_seq}"
        self.line_seq += 1

        start_ms = int(seg.start_sample * 1000 / SAMPLE_RATE)
        end_ms = int(seg.end_sample * 1000 / SAMPLE_RATE)

        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()

        job = TranscriptionJob(
            stream_id=self.stream_id,
            user_id=self.user_id,
            line_id=line_id,
            audio=audio,
            start_ms=start_ms,
            end_ms=end_ms,
            future=fut,
        )

        engine = get_engine()
        try:
            await engine.submit(job)
        except asyncio.QueueFull:
            logger.warning("[stream %d] inference queue full, dropping segment %s",
                           self.stream_id, line_id)
            return {
                "type": "error",
                "code": "inference_queue_full",
                "streamId": self.stream_id,
                "message": "ASR inference queue is full",
            }

        try:
            result = await asyncio.wait_for(fut, timeout=30.0)
        except asyncio.TimeoutError:
            logger.error("[stream %d] inference timeout for %s", self.stream_id, line_id)
            return None
        except Exception:
            logger.exception("[stream %d] inference error for %s", self.stream_id, line_id)
            return None

        text = result["text"]
        if not text:
            return None

        return {
            "type": "final",
            "streamId": self.stream_id,
            "userId": self.user_id,
            "lineId": line_id,
            "text": text,
            "startMs": start_ms,
            "endMs": end_ms,
            "confidence": None,
            "engine": "whisper-large-v3-turbo",
            "latencyMs": result["latencyMs"],
        }
