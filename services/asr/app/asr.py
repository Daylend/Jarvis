"""
Moonshine Voice ASR wrapper. One shared Transcriber with per-user streams.

Moonshine's C API supports multiple streams per Transcriber, sharing a
single ONNX Runtime session. This eliminates redundant model loads and
thread pools when multiple users speak simultaneously.

Moonshine listener callbacks fire on a background thread inside the
moonshine-voice runtime. We bounce every event back to the asyncio loop
that owns the WebSocket using asyncio.run_coroutine_threadsafe so we never
touch the WebSocket from a non-loop thread.
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from typing import Awaitable, Callable

import numpy as np
from moonshine_voice import Transcriber, TranscriptEventListener, ModelArch

from app import config

logger = logging.getLogger(__name__)

EmitCb = Callable[[dict], Awaitable[None]]

_MAX_PARTIAL_SEEN = 256


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

    def detach(self) -> None:
        """Null out loop + emit refs so late callbacks become no-ops and the
        WS event loop is eligible for garbage collection. Call before del."""
        self._loop = None  # type: ignore[assignment]
        self._emit = None  # type: ignore[assignment]

    def _push(self, payload: dict) -> None:
        # Schedule on the WS event loop; this method runs on a Moonshine thread.
        loop = self._loop
        emit = self._emit
        if loop is None or emit is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(emit(payload), loop)
        except RuntimeError as e:
            # Loop may have shut down during teardown; log once and drop.
            logger.warning("[asr stream=%d] could not schedule emit: %s", self._stream_id, e)

    # Partial revisions of the in-progress line.
    def on_line_text_changed(self, event):  # type: ignore[override]
        line = event.line
        line_id = int(line.line_id)
        seen: set = self._ts["first_partial_seen"]
        if line_id not in seen:
            # Bound the set so it doesn't grow unboundedly across a long-running
            # Manual-mode stream. Pop an arbitrary element when full — any line
            # still actively producing partials will be re-added on its next event.
            if len(seen) >= _MAX_PARTIAL_SEEN:
                seen.pop()
            seen.add(line_id)
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


# ── Shared Transcriber singleton ─────────────────────────────────────────

_transcriber: Transcriber | None = None
_transcriber_lock = threading.Lock()


def _build_options(stream_id: int | None = None) -> dict:
    opts = {
        "return_audio_data": "false",
        "identify_speakers": "false",
        "vad_threshold": str(config.VAD_THRESHOLD),
        "vad_window_duration": str(config.VAD_WINDOW_DURATION),
        "vad_look_behind_sample_count": str(config.VAD_LOOK_BEHIND_SAMPLES),
        "vad_max_segment_duration": str(config.VAD_MAX_SEGMENT),
        "log_output_text": "true" if config.LOG_OUTPUT_TEXT else "false",
    }
    if config.SAVE_INPUT_WAV_DIR and stream_id is not None:
        os.makedirs(config.SAVE_INPUT_WAV_DIR, exist_ok=True)
        opts["save_input_wav_path"] = os.path.join(
            config.SAVE_INPUT_WAV_DIR, f"stream-{stream_id}.wav"
        )
    return opts


def get_transcriber() -> Transcriber:
    """Return the singleton Transcriber, creating it on first access."""
    global _transcriber
    if _transcriber is not None:
        return _transcriber
    with _transcriber_lock:
        if _transcriber is not None:
            return _transcriber
        _transcriber = Transcriber(
            model_path=config.MODEL_PATH,
            model_arch=ModelArch(config.MODEL_ARCH),
            update_interval=config.UPDATE_INTERVAL,
            options=_build_options(),
        )
        # Use a dummy listener on the default stream so the Transcriber
        # starts its background threads. We never feed the default stream —
        # all audio goes through per-user streams created by build_stream().
        _transcriber.start()
        logger.info(
            "[asr] Shared Transcriber started update_interval=%.3fs vad_window=%.3fs vad_max_segment=%.1fs",
            config.UPDATE_INTERVAL, config.VAD_WINDOW_DURATION, config.VAD_MAX_SEGMENT,
        )
        return _transcriber


def shutdown_global_transcriber() -> None:
    """Stop the singleton Transcriber. Called once at process exit."""
    global _transcriber
    if _transcriber is None:
        return
    logger.info("[asr] Shutting down shared Transcriber")
    try:
        _transcriber.stop()
    except Exception:
        logger.exception("[asr] Transcriber.stop() failed")
    _transcriber = None


# ── Per-user stream helpers ─────────────────────────────────────────────

def build_stream(
    *,
    loop: asyncio.AbstractEventLoop,
    emit: EmitCb,
    stream_id: int,
    timestamps: dict,
) -> object:
    """Create a Moonshine stream on the shared Transcriber.

    Returns a Moonshine stream object that supports add_listener(),
    start(), add_audio(), and stop().
    """
    transcriber = get_transcriber()
    stream = transcriber.create_stream(update_interval=config.UPDATE_INTERVAL)
    bridge = _Bridge(loop, emit, stream_id, timestamps)
    stream.add_listener(bridge)
    # Stash the bridge for detach on shutdown — avoids ref-cycle leaks.
    stream._paxfax_bridge = bridge  # type: ignore[attr-defined]
    stream.start()
    logger.info("[asr] Stream %d started on shared Transcriber", stream_id)
    return stream


def feed_pcm_to_stream(stream: object, pcm_s16le: bytes) -> None:
    """Convert s16le mono → float32 mono in [-1, 1] and feed stream."""
    if not pcm_s16le:
        return
    audio = np.frombuffer(pcm_s16le, dtype=np.int16).astype(np.float32) / 32768.0
    stream.add_audio(audio, config.SAMPLE_RATE)


def feed_silence_to_stream(stream: object, duration_ms: int) -> None:
    """Inject zero-valued float32 audio to trigger VAD endpoint detection."""
    n_samples = int(config.SAMPLE_RATE * duration_ms / 1000)
    silence = np.zeros(n_samples, dtype=np.float32)
    stream.add_audio(silence, config.SAMPLE_RATE)


async def shutdown_stream(stream: object) -> None:
    """Stop one user's stream and detach its listener bridge.

    The shared Transcriber stays alive — only this stream is torn down."""
    logger.info("[asr] Shutting down stream")
    await asyncio.to_thread(stream.stop)

    bridge = getattr(stream, "_paxfax_bridge", None)
    if bridge is not None:
        try:
            bridge.detach()
        except Exception:
            pass
        try:
            stream._paxfax_bridge = None  # type: ignore[attr-defined]
        except Exception:
            pass


# ── Backwards-compat aliases (kept for external callers) ────────────────

def feed_pcm_s16le(transcriber: object, pcm_s16le: bytes) -> None:
    """DEPRECATED: kept for backwards compat. Use feed_pcm_to_stream instead."""
    if not pcm_s16le:
        return
    audio = np.frombuffer(pcm_s16le, dtype=np.int16).astype(np.float32) / 32768.0
    transcriber.add_audio(audio, config.SAMPLE_RATE)


async def shutdown_transcriber(transcriber: object) -> None:
    """DEPRECATED: kept for backwards compat. Use shutdown_stream instead."""
    await asyncio.to_thread(transcriber.stop)
    bridge = getattr(transcriber, "_paxfax_bridge", None)
    if bridge is not None:
        try:
            bridge.detach()
        except Exception:
            pass
        try:
            transcriber._paxfax_bridge = None  # type: ignore[attr-defined]
        except Exception:
            pass
    try:
        del transcriber
    except Exception:
        pass


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
