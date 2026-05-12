"""
Silero VAD wrapper using the silero-vad package (ONNX, CPU).
Each per-user stream gets its own VAD instance to maintain independent state.
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
    Quick single-chunk speech check.
    Returns True if Silero VAD detects speech in the given PCM chunk.
    pcm_s16le: raw s16le bytes at SAMPLE_RATE Hz, mono.
    """
    global _diag_call_count

    if len(pcm_s16le) < 2:
        return False

    audio_int16 = np.frombuffer(pcm_s16le, dtype=np.int16)
    audio = audio_int16.astype(np.float32) / 32768.0
    model = get_model()

    # --- DIAGNOSTIC: log raw VAD probability score and audio stats ---
    if _diag_call_count < _DIAG_MAX_CALLS:
        _diag_call_count += 1
        peak = int(np.abs(audio_int16).max())
        rms = float(np.sqrt(np.mean(audio_int16.astype(np.float32) ** 2)))
        n_samples = len(audio_int16)
        # Call the model directly to get the raw probability score
        try:
            audio_tensor = torch.from_numpy(audio)
            raw_prob = float(model(audio_tensor, SAMPLE_RATE).item())
        except Exception as e:
            raw_prob = -1.0
            logger.warning(f"[vad diag] direct model call failed: {e}")
        logger.info(
            f"[vad diag #{_diag_call_count}] samples={n_samples} peak={peak} rms={rms:.1f} "
            f"raw_prob={raw_prob:.4f} threshold={VAD_THRESHOLD}"
        )
    # --- END DIAGNOSTIC ---

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
