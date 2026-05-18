import os


TTS_DEVICE = os.getenv("TTS_DEVICE", "cuda:0")
TTS_REF_AUDIO = os.getenv("TTS_REF_AUDIO", "/app/voice_samples/ultron.mp3")
TTS_REF_TEXT = os.getenv(
    "TTS_REF_TEXT",
    "I'm sorry I know you mean well... You just didn't think it through.",
)
TTS_SAMPLE_RATE = int(os.getenv("TTS_SAMPLE_RATE", "24000"))
TTS_CFG_STEPS = int(os.getenv("TTS_CFG_STEPS", "25"))
TTS_SPEED = float(os.getenv("TTS_SPEED", "1.0"))
TTS_VOCODER_NAME = os.getenv("TTS_VOCODER_NAME", "vocos")
TTS_PORT = int(os.getenv("TTS_PORT", "8860"))
