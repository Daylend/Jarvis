"""Configuration for the Whisper ROCm ASR sidecar. All values from environment."""
from pydantic import BaseModel
import os


class Settings(BaseModel):
    model_id: str = os.getenv("ASR_MODEL_ID", "openai/whisper-large-v3-turbo")
    device: str = os.getenv("ASR_DEVICE", "cuda:0")
    dtype: str = os.getenv("ASR_DTYPE", "float16")
    language: str = os.getenv("ASR_LANGUAGE", "en")
    task: str = os.getenv("ASR_TASK", "transcribe")
    port: int = int(os.getenv("ASR_PORT", "8765"))
    enable_partials: bool = os.getenv("ASR_ENABLE_PARTIALS", "false").lower() == "true"
    sample_rate: int = 16000

    vad_threshold: float = float(os.getenv("ASR_VAD_THRESHOLD", "0.50"))
    vad_min_speech_ms: int = int(os.getenv("ASR_VAD_MIN_SPEECH_MS", "250"))
    vad_min_silence_ms: int = int(os.getenv("ASR_VAD_MIN_SILENCE_MS", "800"))
    vad_speech_pad_ms: int = int(os.getenv("ASR_VAD_SPEECH_PAD_MS", "300"))
    max_utterance_s: float = float(os.getenv("ASR_MAX_UTTERANCE_S", "24.0"))
    min_final_audio_ms: int = int(os.getenv("ASR_MIN_FINAL_AUDIO_MS", "300"))

    inference_queue_max: int = int(os.getenv("ASR_INFERENCE_QUEUE_MAX", "64"))

    max_buffer_s: float = 32.0


settings = Settings()
