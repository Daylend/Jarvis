import io
import json
import logging
import os
import re
import subprocess
import wave

import numpy as np
import torch

logger = logging.getLogger(__name__)

RUNTIME = None
CURRENT_VOICE = None
DEVICE = None
SAMPLE_RATE = None
SPEED = 1.0
REF_AUDIO_PATH = None
REF_TEXT = None

# Chunking splits text on sentence boundaries; dots.tts caps total audio patch
# count (DOTS_MAX_GENERATE_LENGTH) and raises ValueError when exceeded. Splitting
# long LLM replies keeps each generate() call under the patch budget and bounds
# per-call VRAM/latency. The bot concatenates the returned WAV frames anyway.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?。！？])\s+|\n+")


def _save_settings():
    from app.config import TTS_SETTINGS_PATH
    settings = {"voice": CURRENT_VOICE, "speed": SPEED}
    try:
        with open(TTS_SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(settings, f)
        logger.info("Saved dots.tts settings to %s: %s", TTS_SETTINGS_PATH, settings)
    except Exception:
        logger.exception("Failed to save dots.tts settings to %s", TTS_SETTINGS_PATH)


def _load_saved_settings():
    from app.config import TTS_SETTINGS_PATH
    try:
        with open(TTS_SETTINGS_PATH, "r", encoding="utf-8") as f:
            settings = json.load(f)
        voice = settings.get("voice")
        speed = settings.get("speed")
        if not isinstance(voice, str) or not isinstance(speed, (int, float)):
            logger.warning("Invalid dots.tts settings format in %s, ignoring", TTS_SETTINGS_PATH)
            return None
        logger.info("Loaded dots.tts settings from %s: voice=%s speed=%s", TTS_SETTINGS_PATH, voice, speed)
        return settings
    except FileNotFoundError:
        logger.info("No saved dots.tts settings at %s, using defaults", TTS_SETTINGS_PATH)
        return None
    except Exception:
        logger.exception("Failed to load dots.tts settings from %s", TTS_SETTINGS_PATH)
        return None


def get_engine_info() -> dict:
    from app.config import DOTS_MODEL, DOTS_NUM_STEPS, DOTS_GUIDANCE_SCALE, DOTS_PRECISION
    return {
        "engine": "dots-tts",
        "device": DEVICE or "not-loaded",
        "sample_rate": SAMPLE_RATE or 0,
        "nfe_step": DOTS_NUM_STEPS,
        "epss_active": None,
        "model": DOTS_MODEL if RUNTIME is not None else "not-loaded",
        "guidance": DOTS_GUIDANCE_SCALE,
        "precision": DOTS_PRECISION,
    }


def is_loaded() -> bool:
    return RUNTIME is not None


def get_current_voice() -> str | None:
    return CURRENT_VOICE


def get_speed() -> float:
    return SPEED


def set_speed(value: float) -> float:
    global SPEED
    SPEED = round(value, 2)
    logger.info("dots.tts speed set to %s", SPEED)
    _save_settings()
    return SPEED


def _transcript_path(audio_path: str) -> str:
    base, _ = os.path.splitext(audio_path)
    return base + ".txt"


def set_ref_audio(path: str):
    global REF_AUDIO_PATH, REF_TEXT, CURRENT_VOICE
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Voice sample not found: {path}")
    tx_path = _transcript_path(path)
    if not os.path.isfile(tx_path):
        raise FileNotFoundError(
            f"Transcript file not found: {tx_path} — create a .txt file "
            f"with the exact text spoken in the reference audio"
        )
    with open(tx_path, "r", encoding="utf-8") as f:
        ref_text_content = f.read().strip()
    if not ref_text_content:
        raise ValueError(f"Transcript file is empty: {tx_path}")

    REF_AUDIO_PATH = path
    REF_TEXT = ref_text_content
    CURRENT_VOICE = os.path.basename(path)
    logger.info("Switched dots.tts reference voice to %s", CURRENT_VOICE)
    _save_settings()


def _ensure_loaded():
    global RUNTIME, DEVICE, SAMPLE_RATE, SPEED, CURRENT_VOICE, REF_AUDIO_PATH, REF_TEXT
    if RUNTIME is not None:
        return

    from app.config import (
        DOTS_MODEL,
        DOTS_PRECISION,
        DOTS_OPTIMIZE,
        DOTS_MAX_GENERATE_LENGTH,
        DOTS_SEED,
        TTS_DEVICE,
        TTS_REF_AUDIO,
        TTS_SPEED,
    )

    from dots_tts.runtime import DotsTtsRuntime
    from dots_tts.utils.util import seed_everything

    seed_everything(DOTS_SEED)
    logger.info(
        "Loading dots.tts model=%s precision=%s optimize=%s max_generate_length=%s seed=%s ...",
        DOTS_MODEL, DOTS_PRECISION, DOTS_OPTIMIZE, DOTS_MAX_GENERATE_LENGTH, DOTS_SEED,
    )

    RUNTIME = DotsTtsRuntime.from_pretrained(
        DOTS_MODEL,
        precision=DOTS_PRECISION,
        optimize=DOTS_OPTIMIZE,
        max_generate_length=DOTS_MAX_GENERATE_LENGTH,
    )
    DEVICE = str(RUNTIME.device)
    SAMPLE_RATE = int(RUNTIME.sample_rate)
    SPEED = TTS_SPEED

    # Respect TTS_DEVICE if the runtime picked a different device than requested
    # (the runtime auto-selects cuda/cpu; we only override on mismatch for logging).
    if TTS_DEVICE and TTS_DEVICE not in DEVICE:
        logger.warning(
            "TTS_DEVICE=%s requested but dots.tts runtime is on %s", TTS_DEVICE, DEVICE,
        )

    set_ref_audio(TTS_REF_AUDIO)

    saved = _load_saved_settings()
    if saved:
        saved_voice = saved.get("voice")
        if saved_voice:
            voice_path = os.path.join("/app/voice_samples", saved_voice)
            if os.path.isfile(voice_path):
                try:
                    set_ref_audio(voice_path)
                except Exception:
                    logger.exception("Failed to restore saved voice %s, keeping default", saved_voice)
            else:
                logger.warning("Saved voice file not found: %s, keeping default", voice_path)
        saved_speed = saved.get("speed")
        if saved_speed is not None:
            set_speed(float(saved_speed))

    logger.info("dots.tts model loaded. device=%s sr=%d", DEVICE, SAMPLE_RATE)


def _warmup():
    import time as time_mod
    _ensure_loaded()
    if REF_AUDIO_PATH is None or REF_TEXT is None:
        logger.warning("No dots.tts reference voice — skipping warmup")
        return
    t0 = time_mod.perf_counter()
    _ = synthesize("Warmup.")
    dur = (time_mod.perf_counter() - t0) * 1000
    logger.info("dots.tts warmup complete in %.0f ms", dur)


def _generate_np(text: str) -> tuple[np.ndarray, int]:
    from app.config import (
        DOTS_NUM_STEPS,
        DOTS_GUIDANCE_SCALE,
        DOTS_SPEAKER_SCALE,
        DOTS_NORMALIZE_TEXT,
        DOTS_LANGUAGE,
    )
    if REF_AUDIO_PATH is None or REF_TEXT is None:
        raise RuntimeError("dots.tts reference voice not set")

    result = RUNTIME.generate(
        text=text,
        prompt_audio_path=REF_AUDIO_PATH,
        prompt_text=REF_TEXT,
        num_steps=DOTS_NUM_STEPS,
        guidance_scale=DOTS_GUIDANCE_SCALE,
        speaker_scale=DOTS_SPEAKER_SCALE,
        normalize_text=DOTS_NORMALIZE_TEXT,
        language=DOTS_LANGUAGE if DOTS_LANGUAGE and DOTS_LANGUAGE.lower() != "none" else None,
    )
    audio = result["audio"]
    sr = int(result["sample_rate"])
    # audio is a torch tensor shaped [1, N] (or [N]); float in [-1, 1].
    if audio.ndim > 1:
        audio = audio.squeeze(0)
    return audio.detach().float().cpu().numpy().astype(np.float32), sr


def _split_text(text: str, max_chars: int) -> list[str]:
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    # Sentence-aware chunking so we don't cut mid-word across generate() calls.
    parts = [p for p in _SENTENCE_SPLIT.split(text) if p]
    chunks: list[str] = []
    buf = ""
    for part in parts:
        if not buf:
            buf = part
        elif len(buf) + 1 + len(part) <= max_chars:
            buf = buf + " " + part
        else:
            chunks.append(buf)
            buf = part
    if buf:
        chunks.append(buf)
    # Fallback: a single sentence longer than max_chars gets hard-split.
    final: list[str] = []
    for c in chunks:
        while len(c) > max_chars:
            final.append(c[:max_chars])
            c = c[max_chars:]
        if c:
            final.append(c)
    return final


def _apply_speed(wav_bytes: bytes, speed: float) -> bytes:
    if abs(speed - 1.0) < 1e-3:
        return wav_bytes
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-i", "pipe:0", "-filter:a", f"atempo={speed:.3f}", "-f", "wav", "pipe:1"],
        input=wav_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        logger.warning("ffmpeg atempo failed (%s); returning un-stretched audio",
                       proc.stderr.decode("utf-8", "ignore")[:200])
        return wav_bytes
    return proc.stdout


def _to_wav_bytes(wav_np: np.ndarray, sr: int) -> bytes:
    wav_int16 = (np.clip(wav_np, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(wav_int16.tobytes())
    buf.seek(0)
    return buf.read()


def _concat_wav(wav_chunks: list[bytes], sr: int) -> bytes:
    """Concatenate multiple 16-bit mono WAV byte blobs into one continuous WAV."""
    if len(wav_chunks) == 1:
        return wav_chunks[0]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        for chunk in wav_chunks:
            with wave.open(io.BytesIO(chunk), "rb") as src:
                wf.writeframes(src.readframes(src.getnframes()))
    buf.seek(0)
    return buf.read()


def synthesize(text: str):
    import time as time_mod
    _ensure_loaded()

    from app.config import DOTS_MAX_CHARS_PER_CALL
    chunks = _split_text(text, DOTS_MAX_CHARS_PER_CALL)
    if not chunks:
        chunks = [text.strip() or "."]

    t0 = time_mod.perf_counter()
    sr = SAMPLE_RATE
    wav_parts: list[bytes] = []
    total_samples = 0
    for i, chunk in enumerate(chunks):
        wav_np, chunk_sr = _generate_np(chunk)
        sr = chunk_sr
        total_samples += int(wav_np.shape[-1])
        wav_parts.append(_to_wav_bytes(wav_np, sr))
        logger.info("dots.tts chunk %d/%d: len=%d audio_dur=%.2fs",
                    i + 1, len(chunks), len(chunk), wav_np.shape[-1] / sr)

    # Speed is applied once across the concatenated audio to avoid per-chunk
    # pitch/timing discontinuities at the atempo boundary.
    wav_bytes = _concat_wav(wav_parts, sr)
    wav_bytes = _apply_speed(wav_bytes, SPEED)

    duration_ms = (time_mod.perf_counter() - t0) * 1000
    audio_dur_s = total_samples / sr
    logger.info(
        "dots.tts synthesized: text_len=%d, chunks=%d, audio_dur=%.2fs, "
        "inference_ms=%.0f, rt_factor=%.1fx",
        len(text),
        len(chunks),
        audio_dur_s,
        duration_ms,
        duration_ms / (audio_dur_s * 1000) if audio_dur_s > 0 else 0,
    )
    return wav_bytes, duration_ms
