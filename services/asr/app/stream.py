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

# Sentinel value pushed into the queue to signal the feeder thread to exit.
_STOP = object()


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

        # Unbounded queue — the bot sends ~50 chunks/s per user at 16 kHz;
        # each chunk is tiny (~640 B). Even if inference lags, memory is fine.
        self._pcm_queue: queue.Queue[bytes | object] = queue.Queue()
        self._feeder = threading.Thread(
            target=self._feed_loop,
            name=f"pcm-feed-{stream_id}",
            daemon=True,
        )
        self._feeder.start()

    # Called from the asyncio event loop — must not block.
    def push_pcm(self, pcm_s16le: bytes) -> None:
        if not pcm_s16le:
            return
        now = time.monotonic()
        if self._timestamps["t"] is None:
            self._timestamps["t"] = now
        self._timestamps["last_pcm"] = now
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
                asr_module.feed_pcm_to_stream(self._stream, item)
            except Exception:
                logger.exception("[stream %d] feed_pcm_s16le error", self.stream_id)

    async def close(self) -> None:
        logger.info("[stream %d] closing (queue depth=%d)", self.stream_id, self._pcm_queue.qsize())
        # Signal the feeder thread to exit and wait for it (off the event loop).
        self._pcm_queue.put_nowait(_STOP)
        await asyncio.to_thread(self._feeder.join, 5.0)
        if self._feeder.is_alive():
            logger.warning("[stream %d] feeder thread did not exit in time", self.stream_id)
        await asr_module.shutdown_stream(self._stream)
        self._stream = None  # type: ignore[assignment]
