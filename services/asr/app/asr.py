"""
whisper.cpp ASR wrapper via pywhispercpp.

The Whisper model is loaded once at startup with the configured backend (Vulkan by default).
Transcription runs in a ThreadPoolExecutor to avoid blocking the asyncio event loop.
"""
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import numpy as np

from app.config import MODEL_PATH, DEVICE, SAMPLE_RATE

logger = logging.getLogger(__name__)

_model = None
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="whisper")
_model_loaded = False
_vulkan_active = False


def _load_model():
    """Load the whisper.cpp model. Called once at startup."""
    global _model, _model_loaded, _vulkan_active

    try:
        from pywhispercpp.model import Model

        # GPU backend (Vulkan/CUDA) is selected purely at build time via CMake flags
        # (-DWHISPER_VULKAN=ON). pywhispercpp.Model only accepts whisper_full_params
        # fields as kwargs; gpu_device and n_gpu_layers are NOT valid fields and will
        # raise AttributeError. No runtime GPU param is needed or supported.
        use_gpu = DEVICE.lower() in ("vulkan", "cuda", "gpu")

        logger.info(f"Loading whisper model from {MODEL_PATH} (device={DEVICE})")
        _model = Model(
            MODEL_PATH,
            n_threads=4,
            print_progress=False,
            print_realtime=False,
            print_timestamps=False,
        )
        _model_loaded = True
        _vulkan_active = use_gpu
        logger.info("Whisper model loaded successfully.")
    except Exception as e:
        logger.error(f"Failed to load whisper model: {e}")
        raise


def is_loaded() -> bool:
    return _model_loaded


def is_vulkan() -> bool:
    return _vulkan_active


def get_engine_info() -> dict:
    return {
        "engine": "whisper.cpp",
        "model": MODEL_PATH.split("/")[-1],
        "vulkan": _vulkan_active,
    }


def _transcribe_sync(pcm_float32: np.ndarray) -> list[dict]:
    """
    Synchronous transcription. Returns list of segment dicts:
    [{"text": str, "t0": int, "t1": int}]  (t0/t1 in whisper centiseconds)
    """
    if _model is None:
        return []
    try:
        segments = _model.transcribe(pcm_float32, language="en")
        return [
            {
                "text": seg.text.strip(),
                "t0": seg.t0,   # centiseconds
                "t1": seg.t1,
            }
            for seg in segments
            if seg.text.strip()
        ]
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        return []


async def transcribe(pcm_s16le: bytes, start_sample: int = 0) -> Optional[dict]:
    """
    Async wrapper around _transcribe_sync.
    pcm_s16le: raw s16le bytes at 16kHz mono.
    start_sample: sample offset of this buffer within the session (for timing).
    Returns {"text": str, "startMs": int, "endMs": int, "confidence": None} or None.
    """
    if not _model_loaded or len(pcm_s16le) < 2:
        return None

    # Convert s16le → float32 in [-1, 1]
    audio = np.frombuffer(pcm_s16le, dtype=np.int16).astype(np.float32) / 32768.0

    loop = asyncio.get_event_loop()
    segments = await loop.run_in_executor(_executor, _transcribe_sync, audio)

    if not segments:
        return None

    full_text = " ".join(s["text"] for s in segments).strip()
    if not full_text:
        return None

    # Convert centiseconds to ms, offset by start_sample
    start_offset_ms = int(start_sample / SAMPLE_RATE * 1000)
    first_t0_ms = segments[0]["t0"] * 10 + start_offset_ms
    last_t1_ms = segments[-1]["t1"] * 10 + start_offset_ms

    return {
        "text": full_text,
        "startMs": first_t0_ms,
        "endMs": last_t1_ms,
        "confidence": None,  # whisper.cpp doesn't expose per-segment confidence easily
    }
