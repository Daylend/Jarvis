"""Configuration for the ASR sidecar. All values from environment."""
from pydantic import BaseModel
import os


class Settings(BaseModel):
    # --- Engine selection ---
    engine: str = os.getenv("ASR_ENGINE", "granite")

    # --- Whisper settings ---
    model_id: str = os.getenv("ASR_MODEL_ID", "openai/whisper-large-v3-turbo")
    device: str = os.getenv("ASR_DEVICE", "cuda:0")
    dtype: str = os.getenv("ASR_DTYPE", "float16")
    language: str = os.getenv("ASR_LANGUAGE", "en")
    task: str = os.getenv("ASR_TASK", "transcribe")
    inference_queue_max: int = int(os.getenv("ASR_INFERENCE_QUEUE_MAX", "64"))

    # --- Granite / OpenAI-compatible settings ---
    openai_base_url: str = os.getenv("ASR_OPENAI_BASE_URL", "http://llama-cpp:8080/v1")
    granite_model: str = os.getenv("ASR_GRANITE_MODEL", "/models/granite-speech-4.1-2b-Q6_K.gguf")
    granite_prompt: str = os.getenv(
        "ASR_GRANITE_PROMPT",
        "transcribe the speech in English only with proper punctuation and capitalization. Do not translate. If non-English speech is present, transcribe only the English speech. The wake word is Jarvis.",
    )
    granite_max_concurrency: int = int(os.getenv("ASR_GRANITE_MAX_CONCURRENCY", "4"))
    granite_timeout_s: float = float(os.getenv("ASR_GRANITE_TIMEOUT_S", "30"))

    # --- Shared ---
    port: int = int(os.getenv("ASR_PORT", "8765"))
    enable_partials: bool = os.getenv("ASR_ENABLE_PARTIALS", "false").lower() == "true"
    sample_rate: int = 16000

    vad_threshold: float = float(os.getenv("ASR_VAD_THRESHOLD", "0.50"))
    vad_min_speech_ms: int = int(os.getenv("ASR_VAD_MIN_SPEECH_MS", "200"))
    vad_min_silence_ms: int = int(os.getenv("ASR_VAD_MIN_SILENCE_MS", "500"))
    vad_speech_pad_ms: int = int(os.getenv("ASR_VAD_SPEECH_PAD_MS", "300"))
    max_utterance_s: float = float(os.getenv("ASR_MAX_UTTERANCE_S", "10.0"))
    min_final_audio_ms: int = int(os.getenv("ASR_MIN_FINAL_AUDIO_MS", "300"))

    endpoint_idle_ms: int = int(os.getenv("ASR_ENDPOINT_IDLE_MS", "1200"))
    endpoint_silence_ms: int = int(os.getenv("ASR_ENDPOINT_SILENCE_MS", "600"))

    max_buffer_s: float = 32.0

    # --- Smart Turn (semantic end-of-turn) ---
    smart_turn_enabled: bool = os.getenv("ASR_SMART_TURN_ENABLED", "true").lower() == "true"
    # HF filename (resolved against smart_turn_repo) or an absolute path to a
    # local ONNX file. The int8 CPU model is the default (small + fast on CPU).
    smart_turn_model: str = os.getenv("ASR_SMART_TURN_MODEL", "smart-turn-v3.2-cpu.onnx")
    smart_turn_repo: str = os.getenv("ASR_SMART_TURN_REPO", "pipecat-ai/smart-turn-v3")
    smart_turn_sample_rate: int = int(os.getenv("ASR_SMART_TURN_SAMPLE_RATE", "16000"))
    smart_turn_window_s: float = float(os.getenv("ASR_SMART_TURN_WINDOW_S", "8"))
    smart_turn_trigger_silence_ms: int = int(os.getenv("ASR_SMART_TURN_TRIGGER_SILENCE_MS", "200"))
    smart_turn_complete_threshold: float = float(os.getenv("ASR_SMART_TURN_COMPLETE_THRESHOLD", "0.50"))
    smart_turn_commit_grace_ms: int = int(os.getenv("ASR_SMART_TURN_COMMIT_GRACE_MS", "100"))
    smart_turn_hard_silence_ms: int = int(os.getenv("ASR_SMART_TURN_HARD_SILENCE_MS", "1200"))
    smart_turn_max_concurrency: int = int(os.getenv("ASR_SMART_TURN_MAX_CONCURRENCY", "4"))


settings = Settings()
