import io
import json
import logging
import os
import subprocess
import wave

import numpy as np
import torch

logger = logging.getLogger(__name__)

MODEL = None
CURRENT_VOICE = None
DEVICE = None
SAMPLE_RATE = None
SPEED = 1.0
REF_AUDIO = None
REF_TEXT = None
_CURRENT_REF_PATH = None


def _save_settings():
    from app.config import TTS_SETTINGS_PATH
    settings = {"voice": CURRENT_VOICE, "speed": SPEED}
    try:
        with open(TTS_SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(settings, f)
        logger.info("Saved Chatterbox TTS settings to %s: %s", TTS_SETTINGS_PATH, settings)
    except Exception:
        logger.exception("Failed to save Chatterbox TTS settings to %s", TTS_SETTINGS_PATH)


def _load_saved_settings():
    from app.config import TTS_SETTINGS_PATH
    try:
        with open(TTS_SETTINGS_PATH, "r", encoding="utf-8") as f:
            settings = json.load(f)
        voice = settings.get("voice")
        speed = settings.get("speed")
        if not isinstance(voice, str) or not isinstance(speed, (int, float)):
            logger.warning("Invalid Chatterbox TTS settings format in %s, ignoring", TTS_SETTINGS_PATH)
            return None
        logger.info("Loaded Chatterbox TTS settings from %s: voice=%s speed=%s", TTS_SETTINGS_PATH, voice, speed)
        return settings
    except FileNotFoundError:
        logger.info("No saved Chatterbox TTS settings at %s, using defaults", TTS_SETTINGS_PATH)
        return None
    except Exception:
        logger.exception("Failed to load Chatterbox TTS settings from %s", TTS_SETTINGS_PATH)
        return None


def get_engine_info() -> dict:
    return {
        "engine": "chatterbox-turbo",
        "device": DEVICE or "not-loaded",
        "sample_rate": SAMPLE_RATE or 0,
        "nfe_step": None,
        "epss_active": None,
        "model": "ChatterboxTurboTTS" if MODEL is not None else "not-loaded",
    }


def is_loaded() -> bool:
    return MODEL is not None


def get_current_voice() -> str | None:
    return CURRENT_VOICE


def get_speed() -> float:
    return SPEED


def set_speed(value: float) -> float:
    global SPEED
    SPEED = round(value, 2)
    logger.info("Chatterbox TTS speed set to %s", SPEED)
    _save_settings()
    return SPEED


def set_ref_audio(path: str):
    global CURRENT_VOICE, _CURRENT_REF_PATH
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Voice sample not found: {path}")

    from app.config import CHATTERBOX_NORM_LOUDNESS
    logger.info("Preparing Chatterbox conditionals for %s (norm_loudness=%s)...", path, CHATTERBOX_NORM_LOUDNESS)
    MODEL.prepare_conditionals(path, norm_loudness=CHATTERBOX_NORM_LOUDNESS)
    _CURRENT_REF_PATH = path
    CURRENT_VOICE = os.path.basename(path)
    logger.info("Switched Chatterbox reference voice to %s", CURRENT_VOICE)
    _save_settings()


def _ensure_loaded():
    global MODEL, DEVICE, SAMPLE_RATE, SPEED, CURRENT_VOICE, _CURRENT_REF_PATH
    if MODEL is not None:
        return

    from app.config import TTS_DEVICE, TTS_REF_AUDIO, TTS_SPEED
    from chatterbox.tts_turbo import ChatterboxTurboTTS

    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    logger.info("Loading Chatterbox Turbo to %s (torch=%s hip=%s)...",
                DEVICE, torch.__version__, getattr(torch.version, "hip", "N/A"))

    MODEL = ChatterboxTurboTTS.from_pretrained(device=DEVICE)
    SAMPLE_RATE = MODEL.sr
    SPEED = TTS_SPEED

    # Default voice (reference clip must be > 5s; ideally 6-15s)
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

    logger.info("Chatterbox Turbo model loaded. device=%s sr=%d", DEVICE, SAMPLE_RATE)


def _warmup():
    import time as time_mod
    _ensure_loaded()
    if _CURRENT_REF_PATH is None:
        logger.warning("No Chatterbox reference voice — skipping warmup")
        return
    t0 = time_mod.perf_counter()
    _ = _generate("Warmup.")
    dur = (time_mod.perf_counter() - t0) * 1000
    logger.info("Chatterbox warmup complete in %.0f ms", dur)


def _generate(text: str) -> np.ndarray:
    from app.config import (
        CHATTERBOX_TEMPERATURE, CHATTERBOX_TOP_P, CHATTERBOX_TOP_K,
        CHATTERBOX_REPETITION_PENALTY, CHATTERBOX_NORM_LOUDNESS,
    )
    # audio_prompt_path=None -> reuses prepared conditionals from set_ref_audio().
    wav = MODEL.generate(
        text,
        audio_prompt_path=None,
        temperature=CHATTERBOX_TEMPERATURE,
        top_p=CHATTERBOX_TOP_P,
        top_k=CHATTERBOX_TOP_K,
        repetition_penalty=CHATTERBOX_REPETITION_PENALTY,
        norm_loudness=CHATTERBOX_NORM_LOUDNESS,
        # Keep Turbo no-op controls at defaults to avoid warnings.
        cfg_weight=0.0,
        exaggeration=0.0,
        min_p=0.0,
    )
    # wav is a torch tensor shaped [1, N], float in [-1, 1].
    return wav.squeeze(0).detach().cpu().numpy().astype(np.float32)


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


def synthesize(text: str):
    import time as time_mod
    _ensure_loaded()
    t0 = time_mod.perf_counter()

    wav_np = _generate(text)
    sr = SAMPLE_RATE
    wav_bytes = _to_wav_bytes(wav_np, sr)
    wav_bytes = _apply_speed(wav_bytes, SPEED)

    duration_ms = (time_mod.perf_counter() - t0) * 1000
    audio_dur_s = len(wav_np) / sr
    logger.info(
        "Chatterbox synthesized: text_len=%d, audio_dur=%.2fs, inference_ms=%.0f, rt_factor=%.1fx",
        len(text),
        audio_dur_s,
        duration_ms,
        duration_ms / (audio_dur_s * 1000) if audio_dur_s > 0 else 0,
    )
    return wav_bytes, duration_ms
