"""
Silero VAD wrapper using the silero-vad package (ONNX, CPU).

IMPORTANT: Silero VAD's forward() requires EXACTLY 512 samples at 16kHz (1024 bytes).
- get_speech_timestamps() raises ValueError on any other size and silently returns [] → False.
- get_speech_timestamps() also cannot be used for streaming: it requires seeing both the
  start AND end of a speech segment within the buffer to emit timestamps, so it always
  returns [] on single 32ms chunks even when speech_prob > threshold.
- is_speech() calls model.forward() directly for per-frame probability comparison.
"""
import numpy as np
import torch
from silero_vad import load_silero_vad, get_speech_timestamps
from app.config import SAMPLE_RATE, VAD_THRESHOLD


# Load the model once at module level (shared across all streams — stateful LSTM, reset per call)
_model = None


def get_model():
    global _model
    if _model is None:
        _model = load_silero_vad()
    return _model


def is_speech(pcm_s16le: bytes) -> bool:
    """
    Per-frame speech check using model.forward() directly.
    Returns True if speech probability >= VAD_THRESHOLD.

    pcm_s16le: raw s16le bytes at SAMPLE_RATE Hz, mono — MUST be exactly 1024 bytes (512 samples).
    """
    if len(pcm_s16le) < 2:
        return False

    audio = np.frombuffer(pcm_s16le, dtype=np.int16).astype(np.float32) / 32768.0
    model = get_model()
    speech_prob = float(model(torch.from_numpy(audio), SAMPLE_RATE).item())
    return speech_prob >= VAD_THRESHOLD


def find_speech_segments(pcm_s16le: bytes) -> list[dict]:
    """
    Returns a list of {start, end} dicts (in samples) for speech regions in the buffer.
    Suitable for post-processing full utterance buffers, not streaming chunks.
    """
    if len(pcm_s16le) < 2:
        return []
    audio = np.frombuffer(pcm_s16le, dtype=np.int16).astype(np.float32) / 32768.0
    model = get_model()
    return get_speech_timestamps(
        audio,
        model,
        threshold=VAD_THRESHOLD,
        sampling_rate=SAMPLE_RATE,
        min_speech_duration_ms=150,
        min_silence_duration_ms=int(300),
        return_seconds=False,
    )
