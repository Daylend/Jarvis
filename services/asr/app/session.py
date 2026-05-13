"""
Per-WebSocket session. Manages multiple per-user AudioStream instances.
Handles the framing protocol: text JSON control messages + binary PCM with 4-byte streamId prefix.
"""
import asyncio
import json
import logging
import resource
import struct
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from app.stream import StreamHandler
from app import asr as asr_module

logger = logging.getLogger(__name__)

MAX_STREAMS_PER_SESSION = 8


class Session:
    def __init__(self, ws: WebSocket):
        self._ws = ws
        self._streams: dict[int, StreamHandler] = {}  # streamId -> StreamHandler
        self._session_id: str = "unknown"
        self._guild_id: str = "unknown"
        self._channel_id: str = "unknown"
        self._mem_log_task: asyncio.Task | None = None

    async def run(self) -> None:
        """Main receive loop for this WebSocket connection."""
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
            logger.error(f"[session {self._session_id}] Unexpected error: {e}", exc_info=True)
        finally:
            await self._cleanup()

    async def _handle_text(self, raw: str) -> None:
        try:
            msg: dict[str, Any] = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning(f"[session {self._session_id}] Invalid JSON: {raw[:200]}")
            return

        msg_type = msg.get("type")

        if msg_type == "hello":
            self._session_id = msg.get("sessionId", "unknown")
            self._guild_id = msg.get("guildId", "unknown")
            self._channel_id = msg.get("channelId", "unknown")
            logger.info(
                f"[session {self._session_id}] Hello from guild={self._guild_id} "
                f"channel={self._channel_id}"
            )
            info = asr_module.get_engine_info()
            await self._send_json({
                "type": "ready",
                "engine": info["engine"],
                "model": info["model"],
                "vulkan": info["vulkan"],
            })

        elif msg_type == "open":
            stream_id = msg.get("streamId")
            user_id = msg.get("userId", "unknown")
            if stream_id is None:
                return
            if stream_id in self._streams:
                logger.warning(f"[session {self._session_id}] Stream {stream_id} already open, ignoring.")
                return
            # Safety net: refuse to open more than MAX_STREAMS_PER_SESSION
            # Transcribers. With the one-stream-per-(session,userId) lifecycle
            # change on the bot side this should never trigger in normal operation.
            if len(self._streams) >= MAX_STREAMS_PER_SESSION:
                logger.warning(
                    "[session %s] refusing open stream=%s — at cap %d",
                    self._session_id, stream_id, MAX_STREAMS_PER_SESSION,
                )
                await self._send_json({
                    "type": "error",
                    "streamId": stream_id,
                    "message": f"max-streams-per-session ({MAX_STREAMS_PER_SESSION}) reached",
                })
                return
            logger.info(f"[session {self._session_id}] Opening stream {stream_id} for user {user_id}")
            self._streams[stream_id] = StreamHandler(
                stream_id=stream_id,
                user_id=user_id,
                send_cb=self._send_json,
            )

        elif msg_type == "close":
            stream_id = msg.get("streamId")
            if stream_id is None:
                return
            stream = self._streams.pop(stream_id, None)
            if stream:
                logger.info(f"[session {self._session_id}] Closing stream {stream_id}")
                # Drain: let any in-flight emit coroutines (final, partial)
                # scheduled via run_coroutine_threadsafe run before we stop
                # the transcriber. Each sleep(0) yields the event loop once;
                # 5 iterations is enough for a typical batch of callbacks.
                for _ in range(5):
                    await asyncio.sleep(0)
                await stream.close()

        elif msg_type == "ping":
            await self._send_json({"type": "pong"})

        else:
            logger.debug(f"[session {self._session_id}] Unknown message type: {msg_type}")

    async def _handle_binary(self, data: bytes) -> None:
        """
        Binary frame format: [uint32 LE streamId][PCM s16le bytes]
        """
        if len(data) < 4:
            return
        stream_id = struct.unpack_from("<I", data, 0)[0]
        pcm = data[4:]
        stream = self._streams.get(stream_id)
        if stream is None:
            # Stream not yet opened or already closed — silently drop
            return
        logger.debug(f"[session {self._session_id}] binary frame: stream={stream_id} pcm={len(pcm)}B")
        # push_pcm is synchronous (VAD is fast); schedule any async tasks it creates
        stream.push_pcm(pcm)

    async def _send_json(self, payload: dict) -> None:
        try:
            await self._ws.send_text(json.dumps(payload))
        except Exception as e:
            # Log at WARNING so we can see when transcription results are lost
            # because the WebSocket closed before inference finished (e.g. 20s CPU inference
            # outlasting a 15s keepalive ping timeout).
            logger.warning(f"[session {self._session_id}] send_json failed (WS closed?): {e} — payload type={payload.get('type')!r}")

    async def _cleanup(self) -> None:
        """Close all open streams on disconnect."""
        if self._mem_log_task is not None:
            self._mem_log_task.cancel()
            self._mem_log_task = None
        logger.info(f"[session {self._session_id}] Cleaning up {len(self._streams)} stream(s).")
        tasks = [stream.close() for stream in self._streams.values()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._streams.clear()

    async def _log_memory_periodically(self) -> None:
        """Log stream count and RSS every 60 s while the session is alive."""
        while True:
            try:
                await asyncio.sleep(60)
                usage = resource.getrusage(resource.RUSAGE_SELF)
                # ru_maxrss is KB on Linux.
                rss_mb = usage.ru_maxrss / 1024.0
                logger.info(
                    "[session %s] alive streams=%d rss_max_mb=%.1f",
                    self._session_id, len(self._streams), rss_mb,
                )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("[session %s] mem log error: %s", self._session_id, e)
