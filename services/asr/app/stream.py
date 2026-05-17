"""
Per-streamId adapter. Owns one Moonshine stream on the shared Transcriber.

All VAD, segmentation, partial cadence, and final emission is owned by
moonshine-voice itself. This class only:
  1. creates a stream on the shared Transcriber via build_stream(), and
  2. forwards incoming s16le PCM chunks to it via a dedicated feeder thread
     so the asyncio event loop is never blocked by add_audio() or GIL
     contention with Moonshine's inference thread.
"""
import asyncio
import logging
import queue
import threading
import time
from typing import Awaitable, Callable

from app import asr as asr_module

logger = logging.getLogger(__name__)

# Sentinel values pushed into the queue.
_STOP = object()   # signal the feeder thread to exit
_SILENCE = object()  # inject zero audio for VAD endpoint flush


class StreamHandler:
    def __init__(
        self,
        stream_id: int,
        user_id: str,
        send_cb: Callable[[dict], Awaitable[None]],
    ):
        self.stream_id = stream_id
        self.user_id = user_id
        # Shared with _Bridge so listener thread can read first-chunk and last-pcm timestamps.
        self._timestamps: dict = {"t": None, "last_pcm": None, "first_partial_seen": set()}
        loop = asyncio.get_running_loop()
        self._stream = asr_module.build_stream(
            loop=loop,
            emit=send_cb,
            stream_id=stream_id,
            timestamps=self._timestamps,
        )

        # Endpoint flush watchdog state — all mutated only from the watchdog thread.
        self._flush_state: str = "idle"  # idle | flushing | done
        self._flush_count = 0
        self._last_flush_at: float = 0.0

        # Unbounded queue — the bot sends ~50 chunks/s per user at 16 kHz;
        # each chunk is tiny (~640 B). Even if inference lags, memory is fine.
        self._pcm_queue: queue.Queue[bytes | object] = queue.Queue()
        self._feeder = threading.Thread(
            target=self._feed_loop,
            name=f"pcm-feed-{stream_id}",
            daemon=True,
        )
        self._feeder.start()

        self._watchdog_stop = threading.Event()
        self._watchdog = threading.Thread(
            target=self._watchdog_loop,
            name=f"flush-watchdog-{stream_id}",
            daemon=True,
        )
        self._watchdog.start()

    # Called from the asyncio event loop — must not block.
    def push_pcm(self, pcm_s16le: bytes) -> None:
        if not pcm_s16le:
            return
        now = time.monotonic()
        if self._timestamps["t"] is None:
            self._timestamps["t"] = now
        self._timestamps["last_pcm"] = now
        self._flush_state = "idle"  # reset idle detection on new real audio
        self._pcm_queue.put_nowait(pcm_s16le)

    def _feed_loop(self) -> None:
        """Drain the PCM queue and feed Moonshine on a dedicated thread.

        This keeps add_audio() (which may briefly hold the GIL or block on
        an internal ring-buffer) off the asyncio event loop so partials and
        finals can be dispatched promptly via run_coroutine_threadsafe.
        """
        while True:
            item = self._pcm_queue.get()
            if item is _STOP:
                break
            try:
                if isinstance(item, tuple) and item[0] is _SILENCE:
                    asr_module.feed_silence_to_stream(self._stream, item[1])
                else:
                    asr_module.feed_pcm_to_stream(self._stream, item)
            except Exception:
                logger.exception("[stream %d] feed error", self.stream_id)

    def _watchdog_loop(self) -> None:
        """Periodically check for audio idle and inject silence to force VAD endpoint.

        Runs on its own daemon thread. When no PCM has arrived for
        ENDPOINT_IDLE_MS, injects trailing silence so Moonshine's VAD can
        detect the speech endpoint and emit the final.
        """
        poll_interval = 0.05  # 50 ms
        idle_ms = asr_module.config.ENDPOINT_IDLE_MS
        silence_ms = asr_module.config.ENDPOINT_SILENCE_MS
        max_updates = asr_module.config.ENDPOINT_FORCE_UPDATES
        update_interval_ms = asr_module.config.ENDPOINT_FORCE_UPDATE_INTERVAL_MS
        max_silence_ms = asr_module.config.ENDPOINT_MAX_SILENCE_MS

        while not self._watchdog_stop.wait(poll_interval):
            last_pcm = self._timestamps.get("last_pcm")
            if last_pcm is None:
                continue

            now = time.monotonic()
            elapsed_ms = (now - last_pcm) * 1000.0

            if self._flush_state == "idle" and elapsed_ms >= idle_ms:
                inject_ms = min(int(elapsed_ms), max_silence_ms)
                logger.info(
                    "[stream %d] endpoint flush start: idle=%.0fms injecting %dms silence (actual gap)",
                    self.stream_id, elapsed_ms, inject_ms,
                )
                self._pcm_queue.put_nowait((_SILENCE, inject_ms))
                self._flush_state = "flushing"
                self._flush_count = 1
                self._last_flush_at = now

            elif self._flush_state == "flushing":
                if self._flush_count >= max_updates:
                    self._flush_state = "done"
                    logger.info(
                        "[stream %d] endpoint flush done after %d injections",
                        self.stream_id, self._flush_count,
                    )
                    continue
                if (now - self._last_flush_at) * 1000.0 >= update_interval_ms:
                    # Follow-up: smaller silence chunk to trigger another update
                    self._pcm_queue.put_nowait((_SILENCE, update_interval_ms))
                    self._flush_count += 1
                    self._last_flush_at = now
                    logger.debug(
                        "[stream %d] endpoint flush injection %d/%d",
                        self.stream_id, self._flush_count, max_updates,
                    )

    async def close(self) -> None:
        logger.info("[stream %d] closing (queue depth=%d)", self.stream_id, self._pcm_queue.qsize())
        # Stop the watchdog thread first.
        self._watchdog_stop.set()
        await asyncio.to_thread(self._watchdog.join, 5.0)
        if self._watchdog.is_alive():
            logger.warning("[stream %d] watchdog thread did not exit in time", self.stream_id)
        # Signal the feeder thread to exit and wait for it (off the event loop).
        self._pcm_queue.put_nowait(_STOP)
        await asyncio.to_thread(self._feeder.join, 5.0)
        if self._feeder.is_alive():
            logger.warning("[stream %d] feeder thread did not exit in time", self.stream_id)
        await asr_module.shutdown_stream(self._stream)
        self._stream = None  # type: ignore[assignment]
