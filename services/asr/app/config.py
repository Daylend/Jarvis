"""
Configuration for the Moonshine Voice ASR sidecar.

Values come from environment variables. The two MOONSHINE_MODEL_* vars are
written by services/asr/scripts/download-model.sh into /app/models/moonshine.env
and sourced by services/asr/entrypoint.sh before uvicorn starts. Do not hand-edit
moonshine.env — it is generated.
"""
import os


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# --- Moonshine model selection (set by entrypoint via moonshine.env) ---
MODEL_PATH: str = os.environ["MOONSHINE_MODEL_PATH"]
MODEL_ARCH: int = int(os.environ["MOONSHINE_MODEL_ARCH"])
MODEL_LANG: str = os.environ.get("MOONSHINE_LANGUAGE", "en")

# --- Streaming knobs ---
UPDATE_INTERVAL: float = float(os.environ.get("MOONSHINE_UPDATE_INTERVAL", "0.15"))

# --- VAD knobs ---
VAD_THRESHOLD: float = float(os.environ.get("MOONSHINE_VAD_THRESHOLD", "0.3"))
VAD_WINDOW_DURATION: float = float(os.environ.get("MOONSHINE_VAD_WINDOW_DURATION", "0.3"))
VAD_LOOK_BEHIND_SAMPLES: int = int(os.environ.get("MOONSHINE_VAD_LOOK_BEHIND_SAMPLES", "8192"))
VAD_MAX_SEGMENT: float = float(os.environ.get("MOONSHINE_VAD_MAX_SEGMENT_DURATION", "6.0"))

# --- Endpoint flush (silence injection) ---
ENDPOINT_IDLE_MS: int = int(os.environ.get("ASR_ENDPOINT_IDLE_MS", "350"))
ENDPOINT_SILENCE_MS: int = int(os.environ.get("ASR_ENDPOINT_SILENCE_MS", "500"))
ENDPOINT_FORCE_UPDATES: int = int(os.environ.get("ASR_ENDPOINT_FORCE_UPDATES", "3"))
ENDPOINT_FORCE_UPDATE_INTERVAL_MS: int = int(os.environ.get("ASR_ENDPOINT_FORCE_UPDATE_INTERVAL_MS", "150"))

# --- Diagnostics ---
LOG_ORT_RUNS: bool = _bool("MOONSHINE_LOG_ORT_RUNS", True)
LOG_OUTPUT_TEXT: bool = _bool("MOONSHINE_LOG_OUTPUT_TEXT", True)
SAVE_INPUT_WAV_DIR: str = os.environ.get("MOONSHINE_SAVE_INPUT_WAV_DIR", "")  # empty = disabled

# --- Audio contract from the bot ---
SAMPLE_RATE: int = 16000  # bot sends s16le mono at this rate; do not change
