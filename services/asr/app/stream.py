"""Per-user audio stream: ring buffer, VAD, inference submission."""
from __future__ import annotations
import asyncio
import logging
import time
from typing import Awaitable, Callable, Optional

import numpy as np

from .config import settings
from .engines import get_engine
from .engines.base import EngineBusyError
from .smart_turn import get_pool
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
    def __init__(self, stream_id: int, user_id: str,
                 send_cb: Callable[[dict], Awaitable[None]]):
        self.stream_id = stream_id
        self.user_id = user_id
        self.samples_seen: int = 0
        self.line_seq: int = 0
        self._send_cb = send_cb

        max_samples = int(settings.max_buffer_s * SAMPLE_RATE)
        self.ring = RingBuffer(max_samples)

        # Smart Turn is only "effective" if enabled in config AND the ONNX
        # actually loaded at startup. A load failure degrades to the plain
        # min-silence endpointing path rather than leaving closes to the hard
        # fallback alone.
        st_loaded = get_pool().status.loaded
        self._smart_turn_enabled = settings.smart_turn_enabled and st_loaded
        if settings.smart_turn_enabled and not st_loaded:
            logger.warning(
                "[stream %d] Smart Turn enabled in config but model not loaded — "
                "falling back to plain VAD endpointing", stream_id,
            )
        self.vad = VadState(stream_id, smart_turn_enabled=self._smart_turn_enabled)

        self._last_pcm_time: float = 0.0
        self._watchdog_task: asyncio.Task | None = None
        self._flush_injected: bool = False

        # --- Smart Turn per-stream state ---
        # revision increments on each new speech run; in-flight inference
        # results are discarded if the snapshot no longer matches.
        self._revision: int = 0
        # last WINDOW_S of the current turn, fed for Smart Turn inference input
        self._turn_window_samples = int(settings.smart_turn_window_s * SAMPLE_RATE)
        self._current_turn_pcm = RingBuffer(self._turn_window_samples)
        # a provisional final we're holding open in case speech resumes
        self._candidate: dict | None = None  # {lineId, deadline}
        self._prev_in_speech: bool = False
        self._st_task: asyncio.Task | None = None

        if self._smart_turn_enabled:
            self.vad.set_trigger_silence_callback(self._on_trigger_silence)

    def _on_trigger_silence(self, _frame_end_sample: int) -> None:
        """Sync callback from VAD at ~trigger_silence of silence. Schedule inference."""
        if self._candidate is not None:
            return  # already holding a provisional final for this turn
        if self._st_task is not None and not self._st_task.done():
            return  # an evaluation is already in flight for this silence run
        snapshot = self._revision
        audio = self._current_turn_pcm.slice(
            self._current_turn_pcm.write_pos - self._turn_window_samples,
            self._current_turn_pcm.write_pos,
        ) if self._current_turn_pcm.write_pos > 0 else np.empty(0, dtype=np.float32)
        if len(audio) == 0:
            return
        self._st_task = asyncio.create_task(self._eval_smart_turn(audio, snapshot))

    async def _eval_smart_turn(self, audio: np.ndarray, snapshot: int) -> None:
        pool = get_pool()
        fut = pool.submit(audio)
        if fut is None:
            return  # Smart Turn unavailable
        try:
            p_done = await asyncio.wrap_future(fut)
        except Exception:
            logger.exception("[stream %d] smart-turn inference failed", self.stream_id)
            return

        if snapshot != self._revision:
            logger.debug("[stream %d] smart-turn stale (snapshot=%d now=%d)",
                         self.stream_id, snapshot, self._revision)
            return

        if p_done < settings.smart_turn_complete_threshold:
            logger.info("[stream %d] smart-turn incomplete (p=%.3f) — keep listening",
                        self.stream_id, p_done)
            return

        # Confident the turn is complete → close now.
        if not self.vad.in_speech or self._candidate is not None:
            return
        if snapshot != self._revision:
            return  # speech resumed between inference and close
        seg = self.vad.force_close_segment()
        if seg is None:
            return
        logger.info("[stream %d] smart-turn complete (p=%.3f) — provisional close",
                    self.stream_id, p_done)
        self._prev_in_speech = self.vad.in_speech
        event = await self._finalize_segment(seg, provisional=True)
        if event is None:
            return
        # Speech may have resumed during Granite transcription. If so, drop the
        # provisional final — the resumed run becomes a new segment/lineId, and
        # the bot never receives a final for the abandoned prefix.
        if snapshot != self._revision:
            logger.info("[stream %d] smart-turn provisional dropped — speech resumed during transcription",
                        self.stream_id)
            return
        await self._send_cb(event)
        self._candidate = {
            "lineId": event.get("lineId"),
            "deadline": time.monotonic() + settings.smart_turn_commit_grace_ms / 1000.0,
        }

    async def _emit_reopen(self) -> None:
        if self._candidate is None:
            return
        line_id = self._candidate.get("lineId")
        self._candidate = None
        logger.info("[stream %d] reopen lineId=%s — speech resumed",
                    self.stream_id, line_id)
        await self._send_cb({
            "type": "reopen",
            "streamId": self.stream_id,
            "lineId": line_id,
        })

    async def accept_pcm(self, pcm_bytes: bytes) -> list[dict]:
        audio = pcm_s16le_to_float32(pcm_bytes)
        if len(audio) == 0:
            return []

        self._last_pcm_time = time.monotonic()
        self._flush_injected = False

        abs_start = self.samples_seen
        self.ring.append(audio)
        self.samples_seen += len(audio)

        if self.samples_seen <= SAMPLE_RATE:
            logger.info("[stream %d] accept_pcm: %d bytes -> %d samples (total: %d)",
                        self.stream_id, len(pcm_bytes), len(audio), self.samples_seen)

        if self._watchdog_task is None:
            self._watchdog_task = asyncio.create_task(self._watchdog_loop())

        segments = self.vad.accept(audio, abs_start)

        # --- Smart Turn bookkeeping (only when enabled) ---
        if self._smart_turn_enabled:
            cur_in_speech = self.vad.in_speech
            if not self._prev_in_speech and cur_in_speech:
                # New speech run. Invalidate any pending inference and, if we
                # were holding a provisional final, tell the bot to drop it.
                self._revision += 1
                self._current_turn_pcm = RingBuffer(self._turn_window_samples)
                if self._candidate is not None:
                    await self._emit_reopen()
            if cur_in_speech:
                self._current_turn_pcm.append(audio)
            self._prev_in_speech = cur_in_speech

            # Expire a candidate that survived its grace window without a
            # reopen — the bot has already committed it.
            if (
                self._candidate is not None
                and time.monotonic() >= self._candidate["deadline"]
            ):
                self._candidate = None

        events: list[dict] = []
        for seg in segments:
            event = await self._finalize_segment(seg, provisional=False)
            if event is not None:
                events.append(event)

        return events

    async def flush(self) -> list[dict]:
        if self._watchdog_task is not None:
            self._watchdog_task.cancel()
            try:
                await self._watchdog_task
            except asyncio.CancelledError:
                pass
            self._watchdog_task = None
        if self._st_task is not None and not self._st_task.done():
            self._st_task.cancel()
            try:
                await self._st_task
            except (asyncio.CancelledError, Exception):
                pass
        # Drop any held provisional final on stream close (no reopen emitted —
        # the bot treats a missing final+reopen as a no-op).
        self._candidate = None
        seg = self.vad.flush()
        if seg is None:
            return []
        event = await self._finalize_segment(seg, provisional=False)
        return [event] if event else []

    async def _watchdog_loop(self) -> None:
        if self._smart_turn_enabled:
            idle_s = settings.smart_turn_hard_silence_ms / 1000.0
        else:
            idle_s = settings.endpoint_idle_ms / 1000.0
        poll_s = min(idle_s / 4.0, 0.1)
        try:
            while True:
                await asyncio.sleep(poll_s)
                if self._last_pcm_time == 0.0:
                    continue
                elapsed = time.monotonic() - self._last_pcm_time
                if elapsed < idle_s or self._flush_injected:
                    continue
                if self._smart_turn_enabled:
                    # Hard silence fallback: force-close whatever is still open
                    # (e.g. Smart Turn kept saying "incomplete"). Definitive.
                    seg = self.vad.force_close_segment()
                    if seg is None:
                        self._flush_injected = True
                        continue
                    self._flush_injected = True
                    self._prev_in_speech = self.vad.in_speech
                    logger.info(
                        "[stream %d] hard-silence close: idle=%.0fms",
                        self.stream_id, elapsed * 1000,
                    )
                    event = await self._finalize_segment(seg, provisional=False)
                    if event is not None:
                        await self._send_cb(event)
                else:
                    self._flush_injected = True
                    segments = self._inject_silence()
                    if segments:
                        logger.info(
                            "[stream %d] endpoint flush: idle=%.0fms, injected %dms silence, got %d segment(s)",
                            self.stream_id, elapsed * 1000,
                            settings.endpoint_silence_ms, len(segments),
                        )
                    for seg in segments:
                        event = await self._finalize_segment(seg, provisional=False)
                        if event is not None:
                            await self._send_cb(event)
        except asyncio.CancelledError:
            return

    def _inject_silence(self) -> list[Segment]:
        n_samples = int(settings.endpoint_silence_ms * SAMPLE_RATE / 1000)
        silence = np.zeros(n_samples, dtype=np.float32)
        abs_start = self.samples_seen
        self.ring.append(silence)
        self.samples_seen += n_samples
        return self.vad.accept(silence, abs_start)

    async def _finalize_segment(self, seg: Segment, provisional: bool = False) -> Optional[dict]:
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

        engine = get_engine()
        try:
            result = await asyncio.wait_for(
                engine.transcribe(audio, SAMPLE_RATE), timeout=30.0)
        except EngineBusyError:
            logger.warning("[stream %d] engine busy, dropping segment %s",
                           self.stream_id, line_id)
            return {
                "type": "error",
                "code": "inference_queue_full",
                "streamId": self.stream_id,
                "message": "ASR engine is busy",
            }
        except asyncio.CancelledError:
            raise
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
            "engine": engine.label,
            "latencyMs": result["latencyMs"],
            "provisional": provisional,
        }
