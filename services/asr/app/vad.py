"""
Silero VAD wrapper using the silero-vad package (ONNX, CPU).
Each per-user stream gets its own VAD instance to maintain independent state.
"""
import numpy as np
from silero_vad import load_silero_vad, get_speech_timestamps
from app.config import SAMPLE_RATE, VAD_THRESHOLD


# Load the model once at module level (shared across all streams — it's stateless for inference)
_model = None


def get_model():
    global _model
    if _model is None:
        _model = load_silero_vad()
    return _model


def is_speech(pcm_s16le: bytes) -> bool:
    """
    Quick single-chunk speech check.
    Returns True if Silero VAD detects speech in the given PCM chunk.
    pcm_s16le: raw s16le bytes at SAMPLE_RATE Hz, mono.
    """
    if len(pcm_s16le) < 2:
        return False
    audio = np.frombuffer(pcm_s16le, dtype=np.int16).astype(np.float32) / 32768.0
    model = get_model()
    # get_speech_timestamps returns a list of dicts with 'start'/'end' sample indices
    timestamps = get_speech_timestamps(
        audio,
        model,
        threshold=VAD_THRESHOLD,
        sampling_rate=SAMPLE_RATE,
        min_speech_duration_ms=100,
        min_silence_duration_ms=100,
    )
    return len(timestamps) > 0


def find_speech_segments(pcm_s16le: bytes) -> list[dict]:
    """
    Returns a list of {start, end} dicts (in samples) for speech regions in the buffer.
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
