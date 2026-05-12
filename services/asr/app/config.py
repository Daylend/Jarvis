import os

MODEL_PATH: str = os.environ.get("MODEL_PATH", "/app/models/ggml-large-v3-turbo-q5_0.bin")
DEVICE: str = os.environ.get("DEVICE", "vulkan")  # "vulkan", "cuda", "cpu"
VAD_THRESHOLD: float = float(os.environ.get("VAD_THRESHOLD", "0.5"))
END_SILENCE_MS: int = int(os.environ.get("END_SILENCE_MS", "700"))
MAX_UTTERANCE_MS: int = int(os.environ.get("MAX_UTTERANCE_MS", "25000"))
PARTIAL_INTERVAL_MS: int = int(os.environ.get("PARTIAL_INTERVAL_MS", "500"))
SAMPLE_RATE: int = 16000
