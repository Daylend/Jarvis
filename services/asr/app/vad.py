"""
Silero VAD wrapper using the silero-vad package (ONNX, CPU).
Each per-user stream gets its own VAD instance to maintain independent state.

IMPORTANT: Silero VAD's forward() requires EXACTLY 512 samples at 16kHz (1024 bytes).
Passing any other size raises ValueError inside get_speech_timestamps(), which silently
returns [] → False. The caller (stream.py) is responsible for slicing to exactly 1024 bytes.
"""
import logging
import numpy as np
import torch
from silero_vad import load_silero_vad, get_speech_timestamps
from app.config import SAMPLE_RATE, VAD_THRESHOLD

logger = logging.getLogger(__name__)

# Load the model once at module level (shared across all streams — it's stateless for inference)
_model = None

# Diagnostic: only log detailed VAD info for the first N calls to avoid log spam
_diag_call_count = 0
_DIAG_MAX_CALLS = 20


def get_model():
    global _model
    if _model is None:
        _model = load_silero_vad()
    return _model


def is_speech(pcm_s16le: bytes) -> bool:
    """
    Quick single-chunk speech check using the model's forward() directly.
    Returns True if the speech probability for this 512-sample chunk exceeds VAD_THRESHOLD.

    pcm_s16le: raw s16le bytes at SAMPLE_RATE Hz, mono — MUST be exactly 1024 bytes (512 samples).

    NOTE: get_speech_timestamps() cannot be used for streaming because it requires seeing
    both the start AND end of a speech segment within the buffer to emit timestamps.
    On a single 32ms chunk it always returns [] even when raw_prob > threshold.
    We call model.forward() directly instead, which returns the per-frame probability.
    """
    global _diag_call_count

    if len(pcm_s16le) < 2:
        return False

    audio_int16 = np.frombuffer(pcm_s16le, dtype=np.int16)
    audio = audio_int16.astype(np.float32) / 32768.0
    model = get_model()

    audio_tensor = torch.from_numpy(audio)
    speech_prob = float(model(audio_tensor, SAMPLE_RATE).item())

    result = speech_prob >= VAD_THRESHOLD

    # --- DIAGNOSTIC: log raw VAD probability score and audio stats ---
    if _diag_call_count < _DIAG_MAX_CALLS:
        _diag_call_count += 1
        peak = int(np.abs(audio_int16).max())
        rms = float(np.sqrt(np.mean(audio_int16.astype(np.float32) ** 2)))
        logger.info(
            f"[vad diag #{_diag_call_count}] samples={len(audio_int16)} peak={peak} rms={rms:.1f} "
            f"speech_prob={speech_prob:.4f} threshold={VAD_THRESHOLD} result={result}"
        )
    # --- END DIAGNOSTIC ---

    return result


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
