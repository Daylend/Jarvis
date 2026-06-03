import os


TTS_DEVICE = os.getenv("TTS_DEVICE", "cuda:0")
TTS_REF_AUDIO = os.getenv("TTS_REF_AUDIO", "/app/voice_samples/ultron.mp3")
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
