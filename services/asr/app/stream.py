"""
Per-user audio stream state machine.

Lifecycle:
  1. PCM chunks arrive via push_pcm().
  2. Silero VAD gates speech: chunks are accumulated in a rolling buffer.
  3. When VAD detects end-of-speech (silence >= END_SILENCE_MS) or buffer exceeds
     MAX_UTTERANCE_MS, the accumulated speech buffer is sent to whisper for a final.
  4. Every PARTIAL_INTERVAL_MS while speech is active, a partial decode is emitted.
  5. The send_cb coroutine is called with {"type": "partial"|"final", ...} dicts.
"""
import asyncio
import logging
import time
from typing import Callable, Awaitable

from app import config
from app.vad import is_speech
from app import asr as asr_module

logger = logging.getLogger(__name__)

# Bytes per ms at 16kHz mono s16le: 16000 samples/s * 2 bytes/sample / 1000 = 32 bytes/ms
BYTES_PER_MS = 32


class AudioStream:
    def __init__(
        self,
        stream_id: int,
        user_id: str,
        send_cb: Callable[[dict], Awaitable[None]],
    ):
        self.stream_id = stream_id
        self.user_id = user_id
        self._send_cb = send_cb

        # Accumulation buffers
        self._speech_buf = bytearray()       # current utterance PCM
        self._speech_start_sample = 0        # sample index when utterance started
        self._total_samples = 0              # total samples received since stream open

        # State
        self._in_speech = False
        self._last_speech_time = 0.0         # monotonic time of last speech chunk
        self._last_partial_time = 0.0        # monotonic time of last partial emit

        # Background task for silence timeout
        self._silence_task: asyncio.Task | None = None

    def push_pcm(self, pcm: bytes) -> None:
        """Called from the WS message handler with raw s16le PCM bytes."""
        if not pcm:
            return

        chunk_samples = len(pcm) // 2
        chunk_ms = len(pcm) // BYTES_PER_MS
        speech_detected = is_speech(pcm)
        logger.info(f"[stream {self.stream_id}] push_pcm {len(pcm)}B/{chunk_ms}ms VAD={speech_detected} in_speech={self._in_speech}")

        if speech_detected:
            if not self._in_speech:
                # Start of a new utterance
                self._in_speech = True
                self._speech_start_sample = self._total_samples
                self._speech_buf = bytearray()
                self._last_partial_time = time.monotonic()
                logger.info(f"[stream {self.stream_id}] Speech started at sample {self._speech_start_sample}")

            self._speech_buf.extend(pcm)
            self._last_speech_time = time.monotonic()

            # Cancel any pending silence timer and restart it
            self._cancel_silence_task()
            self._silence_task = asyncio.create_task(self._silence_timeout())

            # Emit partial if interval elapsed
            now = time.monotonic()
            if (now - self._last_partial_time) * 1000 >= config.PARTIAL_INTERVAL_MS:
                self._last_partial_time = now
                asyncio.create_task(self._emit_partial())

            # Force final if utterance is too long
            buf_ms = len(self._speech_buf) // BYTES_PER_MS
            if buf_ms >= config.MAX_UTTERANCE_MS:
                logger.debug(f"[stream {self.stream_id}] Max utterance length reached, forcing final.")
                self._cancel_silence_task()
                asyncio.create_task(self._emit_final())

        self._total_samples += chunk_samples

    async def _silence_timeout(self) -> None:
        """Wait for END_SILENCE_MS then emit final."""
        await asyncio.sleep(config.END_SILENCE_MS / 1000.0)
        if self._in_speech and self._speech_buf:
            logger.debug(f"[stream {self.stream_id}] Silence timeout, emitting final.")
            await self._emit_final()

    def _cancel_silence_task(self) -> None:
        if self._silence_task and not self._silence_task.done():
            self._silence_task.cancel()
        self._silence_task = None

    async def _emit_partial(self) -> None:
        if not self._speech_buf:
            return
        result = await asr_module.transcribe(bytes(self._speech_buf), self._speech_start_sample)
        if result:
            await self._send_cb({
                "type": "partial",
                "streamId": self.stream_id,
                "text": result["text"],
                "startMs": result["startMs"],
                "endMs": result["endMs"],
            })

    async def _emit_final(self) -> None:
        if not self._speech_buf:
            self._in_speech = False
            return

        buf = bytes(self._speech_buf)
        start_sample = self._speech_start_sample

        # Reset state before async work so new speech can start immediately
        self._speech_buf = bytearray()
        self._in_speech = False
        self._cancel_silence_task()

        result = await asr_module.transcribe(buf, start_sample)
        if result:
            await self._send_cb({
                "type": "final",
                "streamId": self.stream_id,
                "text": result["text"],
                "startMs": result["startMs"],
                "endMs": result["endMs"],
                "confidence": result.get("confidence"),
            })

    async def close(self) -> None:
        """Flush any remaining speech buffer as a final, then clean up."""
        self._cancel_silence_task()
        logger.info(f"[stream {self.stream_id}] close() in_speech={self._in_speech} buf={len(self._speech_buf)}B")
        if self._in_speech and self._speech_buf:
            await self._emit_final()
