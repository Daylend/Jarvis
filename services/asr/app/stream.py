"""
Per-streamId adapter. Owns one Moonshine Transcriber for one Discord user.

All VAD, segmentation, partial cadence, and final emission is owned by
moonshine-voice itself. This class only:
  1. constructs a Transcriber bound to a streamId and a send_cb, and
  2. forwards incoming s16le PCM chunks to it.
"""
import asyncio
import logging
import time
from typing import Awaitable, Callable

from app import asr as asr_module

logger = logging.getLogger(__name__)


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
        self._transcriber = asr_module.build_transcriber(
            loop=loop,
            emit=send_cb,
            stream_id=stream_id,
            timestamps=self._timestamps,
        )

    def push_pcm(self, pcm_s16le: bytes) -> None:
        if not pcm_s16le:
            return
        now = time.monotonic()
        if self._timestamps["t"] is None:
            self._timestamps["t"] = now
        self._timestamps["last_pcm"] = now
        # Synchronous — Moonshine queues internally on its own thread.
        asr_module.feed_pcm_s16le(self._transcriber, pcm_s16le)

    async def close(self) -> None:
        logger.info("[stream %d] closing", self.stream_id)
        await asr_module.shutdown_transcriber(self._transcriber)
