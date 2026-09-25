import os


TTS_DEVICE = os.getenv("TTS_DEVICE", "cuda:0")
TTS_REF_AUDIO = os.getenv("TTS_REF_AUDIO", "/app/voice_samples/reference.wav")
TTS_REF_TEXT = os.getenv(
    "TTS_REF_TEXT",
    "I'm sorry I know you mean well... You just didn't think it through.",
)
TTS_SAMPLE_RATE = int(os.getenv("TTS_SAMPLE_RATE", "24000"))
# Valid EPSS step counts (use_epss=True by default upstream).
# Must be one of {5, 6, 7, 10, 12, 16} or EPSS silently falls back to uniform linspace.
# Recommended: 12=baseline, 10=balanced, 7=fastest (validate on voice clones).
TTS_CFG_STEPS = int(os.getenv("TTS_CFG_STEPS", "12"))
# CFG strength 2.0 = full classifier-free guidance (paper recipe).
# Values < 1e-5 skip CFG entirely; 0.0 was unstable in testing.
TTS_CFG_STRENGTH = float(os.getenv("TTS_CFG_STRENGTH", "2.0"))
TTS_TORCH_COMPILE = os.getenv("TTS_TORCH_COMPILE", "true").lower() == "true"
TTS_SPEED = float(os.getenv("TTS_SPEED", "1.0"))
TTS_VOCODER_NAME = os.getenv("TTS_VOCODER_NAME", "vocos")
TTS_SETTINGS_PATH = os.getenv("TTS_SETTINGS_PATH", "/app/voice_samples/.tts_settings.json")
TTS_PORT = int(os.getenv("TTS_PORT", "8860"))

TTS_ENGINE = os.getenv("TTS_ENGINE", "f5").lower()
CHATTERBOX_TEMPERATURE = float(os.getenv("CHATTERBOX_TEMPERATURE", "0.8"))
CHATTERBOX_TOP_P = float(os.getenv("CHATTERBOX_TOP_P", "0.95"))
CHATTERBOX_TOP_K = int(os.getenv("CHATTERBOX_TOP_K", "1000"))
CHATTERBOX_REPETITION_PENALTY = float(os.getenv("CHATTERBOX_REPETITION_PENALTY", "1.2"))
CHATTERBOX_NORM_LOUDNESS = os.getenv("CHATTERBOX_NORM_LOUDNESS", "true").lower() == "true"

# dots.tts engine — see model_dots.py. The MeanFlow-distilled checkpoint (mf, NFE=4)
# is the speed-optimized variant and the right default for real-time voice chat.
# Swap to rednote-hilab/dots.tts-soar (best SIM, num_steps 10-32) or
# rednote-hilab/dots.tts-base (vanilla pretrained) by changing DOTS_MODEL alone.
DOTS_MODEL = os.getenv("DOTS_MODEL", "rednote-hilab/dots.tts-mf")
# Flow-matching sampling steps. mf is trained for 4; soar/base use 10 (range 10-32).
DOTS_NUM_STEPS = int(os.getenv("DOTS_NUM_STEPS", "4"))
# CFG scale. mf fuses CFG into the student so this is largely a no-op there;
# meaningful for soar/base (paper default 1.2).
DOTS_GUIDANCE_SCALE = float(os.getenv("DOTS_GUIDANCE_SCALE", "1.2"))
DOTS_SPEAKER_SCALE = float(os.getenv("DOTS_SPEAKER_SCALE", "1.5"))
DOTS_PRECISION = os.getenv("DOTS_PRECISION", "bfloat16")
# torch.compile warmup at load (analog of F5 TTS_TORCH_COMPILE). If ROCm compile
# of the dots graph (LLM + DiT + VAE) is unstable, set false and rely on NFE=4.
DOTS_OPTIMIZE = os.getenv("DOTS_OPTIMIZE", "true").lower() == "true"
# Max total audio patch count (prompt + generated). Very long replies may exceed
# this and raise ValueError; the sidecar chunks text to stay under it.
DOTS_MAX_GENERATE_LENGTH = int(os.getenv("DOTS_MAX_GENERATE_LENGTH", "500"))
# WeTextProcessing text normalization. Requires onnxruntime (installed in image).
DOTS_NORMALIZE_TEXT = os.getenv("DOTS_NORMALIZE_TEXT", "false").lower() == "true"
# Language tag: none | auto_detect | code/name (EN, ZH, english, chinese, ...).
DOTS_LANGUAGE = os.getenv("DOTS_LANGUAGE", "none")
# Reproducible clones per voice. seed_everything is called once at load.
DOTS_SEED = int(os.getenv("DOTS_SEED", "42"))
# Soft cap on characters per generate() call; longer text is split server-side
# to respect DOTS_MAX_GENERATE_LENGTH and bound VRAM/latency per chunk.
DOTS_MAX_CHARS_PER_CALL = int(os.getenv("DOTS_MAX_CHARS_PER_CALL", "400"))
