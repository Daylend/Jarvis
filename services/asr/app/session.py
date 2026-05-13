"""
Per-WebSocket session. Manages multiple per-user AudioStream instances.
Handles the framing protocol: text JSON control messages + binary PCM with 4-byte streamId prefix.
"""
import asyncio
import json
import logging
import struct
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from app.stream import StreamHandler
from app import asr as asr_module

logger = logging.getLogger(__name__)


class Session:
    def __init__(self, ws: WebSocket):
        self._ws = ws
        self._streams: dict[int, StreamHandler] = {}  # streamId -> StreamHandler
        self._session_id: str = "unknown"
        self._guild_id: str = "unknown"
        self._channel_id: str = "unknown"

    async def run(self) -> None:
        """Main receive loop for this WebSocket connection."""
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
        logger.info(f"[session {self._session_id}] binary frame: stream={stream_id} pcm={len(pcm)}B")
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
        logger.info(f"[session {self._session_id}] Cleaning up {len(self._streams)} stream(s).")
        tasks = [stream.close() for stream in self._streams.values()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._streams.clear()
