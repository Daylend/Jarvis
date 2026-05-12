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
        import subprocess, shutil

        # GPU backend (Vulkan/CUDA) is selected purely at build time via CMake flags
        # (-DGGML_VULKAN=ON). pywhispercpp.Model only accepts whisper_full_params
        # fields as kwargs; gpu_device and n_gpu_layers are NOT valid fields and will
        # raise AttributeError. No runtime GPU param is needed or supported.
        use_gpu = DEVICE.lower() in ("vulkan", "cuda", "gpu")

        # Log Vulkan device availability so we can confirm GPU passthrough is working
        if use_gpu:
            try:
                vk_info = subprocess.run(
                    ["vulkaninfo", "--summary"],
                    capture_output=True, text=True, timeout=5
                )
                logger.info(f"[vulkan] vulkaninfo output:\n{vk_info.stdout[:2000]}")
                if vk_info.returncode != 0:
                    logger.warning(f"[vulkan] vulkaninfo failed (rc={vk_info.returncode}): {vk_info.stderr[:500]}")
            except Exception as ve:
                logger.warning(f"[vulkan] Could not run vulkaninfo: {ve}")

        logger.info(f"Loading whisper model from {MODEL_PATH} (device={DEVICE})")
        _model = Model(
            MODEL_PATH,
            n_threads=4,
            print_progress=False,
            print_realtime=False,
            print_timestamps=False,
            # Disable whisper's built-in no-speech and low-confidence filters.
            # Silero VAD already gates what reaches whisper, so we don't need
            # whisper to second-guess it.
            #
            # whisper.cpp skips a segment when:
            #   (a) no_speech_prob > no_speech_thold  [default: 0.6]
            #   (b) avg_logprobs < logprob_thold AND no_speech_prob < no_speech_thold
            #
            # Setting no_speech_thold=1.0 makes condition (a) never true
            # (no_speech_prob is in [0,1] so it can never exceed 1.0).
            # Setting logprob_thold=-1.0 disables condition (b) (logprob is
            # always > -1.0 for any real output).
            no_speech_thold=1.0,
            logprob_thold=-1.0,
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
        logger.warning(f"[asr] transcribe() early-exit: model_loaded={_model_loaded} pcm_len={len(pcm_s16le)}")
        return None

    duration_ms = len(pcm_s16le) / 32  # 32 bytes/ms at 16kHz mono s16le
    logger.info(f"[asr] transcribe() called: pcm={len(pcm_s16le)}B ({duration_ms:.0f}ms audio)")

    # Convert s16le → float32 in [-1, 1]
    audio = np.frombuffer(pcm_s16le, dtype=np.int16).astype(np.float32) / 32768.0

    import time as _time
    t0 = _time.monotonic()
    loop = asyncio.get_event_loop()
    segments = await loop.run_in_executor(_executor, _transcribe_sync, audio)
    elapsed_ms = (_time.monotonic() - t0) * 1000

    logger.info(f"[asr] whisper returned {len(segments)} segment(s) in {elapsed_ms:.1f}ms: {segments!r}")

    if not segments:
        logger.warning(f"[asr] transcribe() → None (empty segments for {duration_ms:.0f}ms of audio)")
        return None

    full_text = " ".join(s["text"] for s in segments).strip()
    if not full_text:
        logger.warning(f"[asr] transcribe() → None (segments non-empty but full_text is blank)")
        return None

    logger.info(f"[asr] transcribe() → text={full_text!r}")

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
