"""WebSocket session handler. Preserves protocol from Moonshine sidecar."""
from __future__ import annotations
import asyncio
import json
import logging
import resource
import struct

from fastapi import WebSocket, WebSocketDisconnect

from .config import settings
from .stream import StreamState

logger = logging.getLogger(__name__)

MAX_STREAMS_PER_SESSION = 8


class AsrSession:
    def __init__(self, websocket: WebSocket):
        self._ws = websocket
        self._streams: dict[int, StreamState] = {}
        self._session_id: str = "unknown"
        self._guild_id: str = "unknown"
        self._channel_id: str = "unknown"
        self._mem_log_task: asyncio.Task | None = None

    async def run(self) -> None:
        self._mem_log_task = asyncio.create_task(self._log_memory_periodically())
        try:
            while True:
                message = await self._ws.receive()
                if "text" in message:
                    await self._handle_text(message["text"])
                elif "bytes" in message:
                    await self._handle_binary(message["bytes"])
                elif message.get("type") == "websocket.disconnect":
                    break
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error("[session %s] Unexpected error: %s", self._session_id, e, exc_info=True)
        finally:
            await self._cleanup()

    async def _handle_text(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("[session %s] Invalid JSON: %s", self._session_id, raw[:200])
            return

        msg_type = msg.get("type")

        if msg_type == "hello":
            self._session_id = msg.get("sessionId", "unknown")
            self._guild_id = msg.get("guildId", "unknown")
            self._channel_id = msg.get("channelId", "unknown")
            logger.info("[session %s] Hello from guild=%s channel=%s",
                        self._session_id, self._guild_id, self._channel_id)
            await self._send_json({
                "type": "ready",
                "engine": "whisper-transformers-rocm",
                "model": settings.model_id,
                "vulkan": False,
                "sampleRate": settings.sample_rate,
                "partials": settings.enable_partials,
            })

        elif msg_type == "open":
            stream_id = msg.get("streamId")
            user_id = msg.get("userId", "unknown")
            if stream_id is None:
                return
            if stream_id in self._streams:
                logger.warning("[session %s] Stream %s already open", self._session_id, stream_id)
                return
            if len(self._streams) >= MAX_STREAMS_PER_SESSION:
                logger.warning("[session %s] refusing open stream=%s — at cap %d",
                               self._session_id, stream_id, MAX_STREAMS_PER_SESSION)
                await self._send_json({
                    "type": "error",
                    "streamId": stream_id,
                    "message": f"max-streams-per-session ({MAX_STREAMS_PER_SESSION}) reached",
                })
                return
            logger.info("[session %s] Opening stream %s for user %s",
                        self._session_id, stream_id, user_id)
            self._streams[stream_id] = StreamState(
                stream_id=stream_id, user_id=user_id, send_cb=self._send_json,
            )

        elif msg_type == "close":
            stream_id = msg.get("streamId")
            if stream_id is None:
                return
            stream = self._streams.pop(stream_id, None)
            if stream:
                logger.info("[session %s] Closing stream %s", self._session_id, stream_id)
                flush_events = await stream.flush()
                for event in flush_events:
                    await self._send_json(event)

        elif msg_type == "ping":
            await self._send_json({"type": "pong"})

        else:
            logger.debug("[session %s] Unknown message type: %s", self._session_id, msg_type)

    async def _handle_binary(self, data: bytes) -> None:
        if len(data) < 4:
            return
        stream_id = struct.unpack_from("<I", data, 0)[0]
        pcm = data[4:]
        stream = self._streams.get(stream_id)
        if stream is None:
            return
        events = await stream.accept_pcm(pcm)
        for event in events:
            await self._send_json(event)

    async def _send_json(self, payload: dict) -> None:
        try:
            await self._ws.send_text(json.dumps(payload))
        except Exception as e:
            logger.warning("[session %s] send_json failed: %s — type=%s",
                           self._session_id, e, payload.get("type"))

    async def _cleanup(self) -> None:
        if self._mem_log_task is not None:
            self._mem_log_task.cancel()
            self._mem_log_task = None
        logger.info("[session %s] Cleaning up %d stream(s)", self._session_id, len(self._streams))
        for stream in self._streams.values():
            try:
                flush_events = await stream.flush()
                for event in flush_events:
                    await self._send_json(event)
            except Exception:
                logger.exception("[session %s] flush error during cleanup", self._session_id)
        self._streams.clear()

    async def _log_memory_periodically(self) -> None:
        while True:
            try:
                await asyncio.sleep(60)
                usage = resource.getrusage(resource.RUSAGE_SELF)
                rss_mb = usage.ru_maxrss / 1024.0
                logger.info("[session %s] alive streams=%d rss_max_mb=%.1f",
                            self._session_id, len(self._streams), rss_mb)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("[session %s] mem log error: %s", self._session_id, e)
