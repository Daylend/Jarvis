"""
Moonshine Voice ASR wrapper. One Transcriber instance per audio stream.

Moonshine listener callbacks fire on a background thread inside the
moonshine-voice runtime. We bounce every event back to the asyncio loop
that owns the WebSocket using asyncio.run_coroutine_threadsafe so we never
touch the WebSocket from a non-loop thread.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Awaitable, Callable

import numpy as np
from moonshine_voice import Transcriber, TranscriptEventListener, ModelArch

from app import config

logger = logging.getLogger(__name__)

EmitCb = Callable[[dict], Awaitable[None]]


class _Bridge(TranscriptEventListener):
    """Bridges Moonshine line events into an asyncio coroutine on the WS loop."""

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        emit: EmitCb,
        stream_id: int,
        timestamps: dict,
    ):
        self._loop = loop
        self._emit = emit
        self._stream_id = stream_id
        # timestamps is shared with StreamHandler so both sides can stamp it.
        # Shape: {"t": float | None, "last_pcm": float | None, "first_partial_seen": set[int]}
        self._ts = timestamps

    def _push(self, payload: dict) -> None:
        # Schedule on the WS event loop; this method runs on a Moonshine thread.
        try:
            asyncio.run_coroutine_threadsafe(self._emit(payload), self._loop)
        except RuntimeError as e:
            # Loop may have shut down during teardown; log once and drop.
            logger.warning("[asr stream=%d] could not schedule emit: %s", self._stream_id, e)

    # Partial revisions of the in-progress line.
    def on_line_text_changed(self, event):  # type: ignore[override]
        line = event.line
        line_id = int(line.line_id)
        if line_id not in self._ts["first_partial_seen"]:
            self._ts["first_partial_seen"].add(line_id)
            t_first = self._ts.get("t")
            if t_first is not None:
                latency_ms = (time.monotonic() - t_first) * 1000.0
                logger.info(
                    "[asr-metrics] stream=%d lineId=%d chunk_ingest_to_first_partial_ms=%.1f",
                    self._stream_id, line_id, latency_ms,
                )
        self._push({
            "type": "partial",
            "streamId": self._stream_id,
            "lineId": line_id,
            "text": line.text,
            "startMs": int(line.start_time * 1000),
            "endMs": int((line.start_time + line.duration) * 1000),
        })

    # Authoritative final for a completed line.
    def on_line_completed(self, event):  # type: ignore[override]
        line = event.line
        line_id = int(line.line_id)
        last_pcm = self._ts.get("last_pcm")
        if last_pcm is not None:
            latency_ms = (time.monotonic() - last_pcm) * 1000.0
            logger.info(
                "[asr-metrics] stream=%d lineId=%d last_voiced_chunk_to_final_ms=%.1f",
                self._stream_id, line_id, latency_ms,
            )
        self._push({
            "type": "final",
            "streamId": self._stream_id,
            "lineId": line_id,
            "text": line.text,
            "startMs": int(line.start_time * 1000),
            "endMs": int((line.start_time + line.duration) * 1000),
            "confidence": None,
        })


def build_transcriber(
    *,
    loop: asyncio.AbstractEventLoop,
    emit: EmitCb,
    stream_id: int,
    timestamps: dict,
) -> Transcriber:
    """Create, configure, and start() a Transcriber. Caller owns shutdown."""
    options = {
        "return_audio_data": "false",
        "identify_speakers": "false",
        "vad_threshold": str(config.VAD_THRESHOLD),
        "vad_window_duration": str(config.VAD_WINDOW_DURATION),
        "vad_max_segment_duration": str(config.VAD_MAX_SEGMENT),
        "log_output_text": "true" if config.LOG_OUTPUT_TEXT else "false",
    }

    if config.SAVE_INPUT_WAV_DIR:
        os.makedirs(config.SAVE_INPUT_WAV_DIR, exist_ok=True)
        options["save_input_wav_path"] = os.path.join(
            config.SAVE_INPUT_WAV_DIR, f"stream-{stream_id}.wav"
        )

    transcriber = Transcriber(
        model_path=config.MODEL_PATH,
        model_arch=ModelArch(config.MODEL_ARCH),
        update_interval=config.UPDATE_INTERVAL,
        options=options,
    )
    transcriber.add_listener(_Bridge(loop, emit, stream_id, timestamps))
    transcriber.start()
    logger.info(
        "[asr] Transcriber started stream=%d update_interval=%.3fs vad_window=%.3fs vad_max_segment=%.1fs",
        stream_id, config.UPDATE_INTERVAL, config.VAD_WINDOW_DURATION, config.VAD_MAX_SEGMENT,
    )
    return transcriber


def feed_pcm_s16le(transcriber: Transcriber, pcm_s16le: bytes) -> None:
    """Convert s16le mono → float32 mono in [-1, 1] and feed Moonshine."""
    if not pcm_s16le:
        return
    # numpy int16→float32 cast then divide. Use 32768.0 (not 32767) — matches the
    # int16 range convention everywhere else in this codebase.
    audio = np.frombuffer(pcm_s16le, dtype=np.int16).astype(np.float32) / 32768.0
    transcriber.add_audio(audio, config.SAMPLE_RATE)


async def shutdown_transcriber(transcriber: Transcriber) -> None:
    """stop() may block on internal threads; run in a worker thread."""
    await asyncio.to_thread(transcriber.stop)


def get_engine_info() -> dict:
    return {
        "engine": "moonshine-voice",
        "model": f"en-medium-streaming (arch={config.MODEL_ARCH})",
        "vulkan": False,  # kept in the schema for backwards compat with /healthz
    }


def is_loaded() -> bool:
    """Checks the configured MODEL_PATH, which may be a single .ort file or a
    directory containing .ort component files."""
    try:
        p = config.MODEL_PATH
        if os.path.isdir(p):
            return any(f.endswith('.ort') for f in os.listdir(p))
        return os.path.isfile(p) and os.access(p, os.R_OK)
    except Exception:
        return False
