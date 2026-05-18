import io
import logging
import os
import wave

import numpy as np
import torch
import torchaudio

logger = logging.getLogger(__name__)

MODEL = None
VOCODER = None
REF_SIGNAL = None
REF_COND = None
DEVICE = None
SAMPLE_RATE = None


def _load_reference_audio(path: str, sr: int) -> torch.Tensor:
    audio, file_sr = torchaudio.load(path)
    audio = audio.mean(dim=0, keepdim=True)
    if file_sr != sr:
        audio = torchaudio.functional.resample(audio, file_sr, sr)
    return audio


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


def _ensure_loaded():
    global MODEL, VOCODER, REF_SIGNAL, REF_COND, DEVICE, SAMPLE_RATE
    if MODEL is not None:
        return

    from app.config import (
        TTS_DEVICE,
        TTS_REF_AUDIO,
        TTS_REF_TEXT,
        TTS_SAMPLE_RATE,
        TTS_VOCODER_NAME,
        TTS_SPEED,
    )

    DEVICE = TTS_DEVICE
    SAMPLE_RATE = TTS_SAMPLE_RATE

    logger.info("Loading F5-TTS model to %s (vocoder=%s) ...", DEVICE, TTS_VOCODER_NAME)

    from f5_tts.model import CFM, DiT
    from f5_tts.infer.utils_infer import (
        load_model,
        load_vocoder,
        preprocess_ref_audio_text,
    )

    dtype = torch.float16 if DEVICE.startswith("cuda") else torch.float32

    # Resolve vocabulary file (bundled with f5-tts package)
    import f5_tts

    f5_tts_dir = os.path.dirname(f5_tts.__file__)
    vocab_file = os.path.join(
        f5_tts_dir, "..", "data", "Emilia_ZH_EN_pinyin", "tokenizer.txt"
    )
    vocab_file = os.path.abspath(vocab_file)
    if not os.path.exists(vocab_file):
        vocab_file = None  # let load_model resolve it

    vocoder_local_path = f"checkpoints/{TTS_VOCODER_NAME}"

    model = load_model(
        dit_cls=DiT,
        cfm_cls=CFM,
        ckpt_path=None,
        tokenizer="pinyin",
        vocab_file=vocab_file,
        vocoder_name=TTS_VOCODER_NAME,
        vocoder_local_path=vocoder_local_path,
        device=DEVICE,
        dtype=dtype,
        ode_method="euler",
        use_ema=True,
    )

    vocoder = load_vocoder(
        vocoder_name=TTS_VOCODER_NAME,
        vocoder_local_path=vocoder_local_path,
        device=DEVICE,
    )

    MODEL = model
    VOCODER = vocoder

    ref_audio = _load_reference_audio(TTS_REF_AUDIO, SAMPLE_RATE)
    ref_text = TTS_REF_TEXT

    ref_signal, ref_cond = preprocess_ref_audio_text(
        model=MODEL,
        ref_audio=ref_audio,
        ref_text=ref_text,
        tokenizer="pinyin",
        device=DEVICE,
        ref_audio_sr=SAMPLE_RATE,
    )

    REF_SIGNAL = ref_signal
    REF_COND = ref_cond

    logger.info(
        "F5-TTS model loaded. ref_audio_dur=%.1fs, device=%s",
        ref_audio.shape[-1] / SAMPLE_RATE,
        DEVICE,
    )


def synthesize(text: str):
    import time as time_mod

    _ensure_loaded()

    from app.config import TTS_CFG_STEPS, TTS_SWAY_SAMPLING_STEPS, TTS_SPEED
    from f5_tts.infer.utils_infer import infer_process

    t0 = time_mod.perf_counter()

    ref_signal = REF_SIGNAL.to(DEVICE)
    ref_cond = REF_COND.to(DEVICE)

    with torch.inference_mode():
        wav, sr, _ = infer_process(
            model=MODEL,
            ref_signal=ref_signal,
            ref_cond=ref_cond,
            text=text,
            vocoder=VOCODER,
            speed=TTS_SPEED,
            nfe_step=TTS_CFG_STEPS,
            cfg_strength=2.0,
            sway_sampling_coef=-1.0,
            sway_sampling_steps=TTS_SWAY_SAMPLING_STEPS,
            ode_method="euler",
            use_ema=True,
            device=DEVICE,
        )

    wav_np = wav.to(dtype=torch.float32).cpu().numpy().squeeze()

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
