import io
import json
import logging
import os
import wave

import numpy as np
import torch

logger = logging.getLogger(__name__)

MODEL = None
VOCODER = None
REF_AUDIO = None
REF_TEXT = None
CURRENT_VOICE = None
DEVICE = None
SAMPLE_RATE = None
SPEED = 1.0


def _save_settings():
    from app.config import TTS_SETTINGS_PATH
    settings = {"voice": CURRENT_VOICE, "speed": SPEED}
    try:
        with open(TTS_SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(settings, f)
        logger.info("Saved TTS settings to %s: %s", TTS_SETTINGS_PATH, settings)
    except Exception:
        logger.exception("Failed to save TTS settings to %s", TTS_SETTINGS_PATH)


def _load_saved_settings():
    from app.config import TTS_SETTINGS_PATH
    try:
        with open(TTS_SETTINGS_PATH, "r", encoding="utf-8") as f:
            settings = json.load(f)
        voice = settings.get("voice")
        speed = settings.get("speed")
        if not isinstance(voice, str) or not isinstance(speed, (int, float)):
            logger.warning("Invalid TTS settings format in %s, ignoring", TTS_SETTINGS_PATH)
            return None
        logger.info("Loaded TTS settings from %s: voice=%s speed=%s", TTS_SETTINGS_PATH, voice, speed)
        return settings
    except FileNotFoundError:
        logger.info("No saved TTS settings at %s, using defaults", TTS_SETTINGS_PATH)
        return None
    except Exception:
        logger.exception("Failed to load TTS settings from %s", TTS_SETTINGS_PATH)
        return None


def get_engine_info() -> dict:
    info = {
        "engine": "f5-tts",
        "device": DEVICE or "not-loaded",
        "sample_rate": SAMPLE_RATE or 0,
    }
    if MODEL is not None:
        try:
            info["model"] = type(MODEL).__name__
        except Exception:
            info["model"] = "unknown"
    else:
        info["model"] = "not-loaded"
    return info


def is_loaded() -> bool:
    return MODEL is not None


def get_current_voice() -> str | None:
    return CURRENT_VOICE


def get_speed() -> float:
    return SPEED


def set_speed(value: float) -> float:
    global SPEED
    SPEED = round(value, 2)
    logger.info("TTS speed set to %s", SPEED)
    _save_settings()
    return SPEED


def _transcript_path(audio_path: str) -> str:
    base, _ = os.path.splitext(audio_path)
    return base + ".txt"


def _resolve_ref_text(audio_path: str, fallback_text: str) -> str:
    tx_path = _transcript_path(audio_path)
    if os.path.isfile(tx_path):
        with open(tx_path, "r", encoding="utf-8") as f:
            content = f.read().strip()
        if content:
            logger.info("Using transcript from %s", tx_path)
            return content
    logger.info("No transcript file at %s, using TTS_REF_TEXT env", tx_path)
    return fallback_text


def set_ref_audio(path: str):
    global REF_AUDIO, REF_TEXT, CURRENT_VOICE
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

    from f5_tts.infer.utils_infer import preprocess_ref_audio_text
    ref_audio, ref_text = preprocess_ref_audio_text(
        path, ref_text_content, show_info=logger.info
    )
    REF_AUDIO = ref_audio
    REF_TEXT = ref_text
    CURRENT_VOICE = os.path.basename(path)
    logger.info("Switched TTS reference voice to %s", CURRENT_VOICE)
    _save_settings()


def _ensure_loaded():
    global MODEL, VOCODER, REF_AUDIO, REF_TEXT, DEVICE, SAMPLE_RATE, CURRENT_VOICE, SPEED
    if MODEL is not None:
        return

    from app.config import (
        TTS_DEVICE,
        TTS_REF_AUDIO,
        TTS_REF_TEXT,
        TTS_SAMPLE_RATE,
        TTS_SPEED,
        TTS_VOCODER_NAME,
    )

    DEVICE = TTS_DEVICE
    SAMPLE_RATE = TTS_SAMPLE_RATE
    SPEED = TTS_SPEED

    logger.info("Loading F5-TTS model to %s (vocoder=%s) ...", DEVICE, TTS_VOCODER_NAME)

    from cached_path import cached_path
    from f5_tts.model import DiT
    from f5_tts.infer.utils_infer import (
        load_model,
        load_vocoder,
        preprocess_ref_audio_text,
    )

    vocoder = load_vocoder(vocoder_name=TTS_VOCODER_NAME, device=DEVICE)

    ckpt_path = str(cached_path("hf://SWivid/F5-TTS/F5TTS_v1_Base/model_1250000.safetensors"))

    model_cfg = dict(
        dim=1024,
        depth=22,
        heads=16,
        ff_mult=2,
        text_dim=512,
        text_mask_padding=True,
        qk_norm=None,
        conv_layers=4,
        pe_attn_head=None,
        attn_backend="torch",
        attn_mask_enabled=False,
        checkpoint_activations=False,
    )

    model = load_model(
        model_cls=DiT,
        model_cfg=model_cfg,
        ckpt_path=ckpt_path,
        mel_spec_type=TTS_VOCODER_NAME,
        vocab_file="",
        device=DEVICE,
    )

    MODEL = model
    VOCODER = vocoder

    ref_audio, ref_text = preprocess_ref_audio_text(
        TTS_REF_AUDIO,
        _resolve_ref_text(TTS_REF_AUDIO, TTS_REF_TEXT),
        show_info=logger.info
    )
    REF_AUDIO = ref_audio
    REF_TEXT = ref_text
    CURRENT_VOICE = os.path.basename(TTS_REF_AUDIO)

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

    logger.info("F5-TTS model loaded. device=%s", DEVICE)

def synthesize(text: str):
    import time as time_mod

    _ensure_loaded()

    from app.config import TTS_CFG_STEPS
    from f5_tts.infer.utils_infer import infer_process

    t0 = time_mod.perf_counter()

    wav_np, sr, _ = infer_process(
        ref_audio=REF_AUDIO,
        ref_text=REF_TEXT,
        gen_text=text,
        model_obj=MODEL,
        vocoder=VOCODER,
        nfe_step=TTS_CFG_STEPS,
        cfg_strength=2.0,
        sway_sampling_coef=-1.0,
        speed=SPEED,
        show_info=logger.info,
        progress=None,
        device=DEVICE,
    )

    duration_ms = (time_mod.perf_counter() - t0) * 1000
    audio_dur_s = len(wav_np) / sr

    logger.info(
        "TTS synthesized: text_len=%d, audio_dur=%.2fs, inference_ms=%.0f, rt_factor=%.1fx",
        len(text),
        audio_dur_s,
        duration_ms,
        duration_ms / (audio_dur_s * 1000) if audio_dur_s > 0 else 0,
    )

    # Convert float32 PCM to 16-bit WAV bytes
    wav_int16 = (np.clip(wav_np, -1.0, 1.0) * 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(wav_int16.tobytes())
    buf.seek(0)

    return buf.read(), duration_ms