"""Smart Turn v3.x — semantic end-of-turn classifier (local ONNX inference).

Adapted from pipecat-ai/smart-turn `inference.py` + `audio_utils.py`, but:
  * takes an explicit model path (no hard-coded filename),
  * resolves the ONNX via huggingface_hub at startup (cached under HF_HOME),
  * exposes a process-global session + bounded ThreadPoolExecutor so Smart
    Turn runs off the asyncio loop without blocking, with one InferenceSession
    per process (never per stream).
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import logging
import os
from dataclasses import dataclass
from typing import Optional

import numpy as np

from .config import settings

logger = logging.getLogger(__name__)


def _truncate_to_last_n_seconds(
    audio: np.ndarray, n_seconds: float, sample_rate: int
) -> np.ndarray:
    """Truncate audio to the last n seconds, left-padding short turns with zeros."""
    max_samples = int(n_seconds * sample_rate)
    if len(audio) > max_samples:
        return audio[-max_samples:]
    if len(audio) < max_samples:
        padding = max_samples - len(audio)
        return np.pad(audio, (padding, 0), mode="constant", constant_values=0)
    return audio


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_model_path() -> str:
    """Return a local filesystem path to the Smart Turn ONNX model.

    If ASR_SMART_TURN_MODEL points at an existing file, use it directly.
    Otherwise treat it as a HuggingFace Hub filename inside ASR_SMART_TURN_REPO
    and download it (cached under HF_HOME so restarts don't re-download).
    """
    requested = settings.smart_turn_model
    if os.path.isfile(requested):
        return requested

    # Treat as an HF Hub filename. Import lazily so the slim granite image can
    # boot even if huggingface_hub is momentarily unavailable for a local path.
    from huggingface_hub import hf_hub_download

    cache_dir = os.environ.get("HF_HOME") or os.environ.get("HF_HUB_CACHE")
    logger.info(
        "[smart-turn] resolving ONNX via HF Hub: repo=%s file=%s cache_dir=%s",
        settings.smart_turn_repo, requested, cache_dir,
    )
    path = hf_hub_download(
        repo_id=settings.smart_turn_repo,
        filename=requested,
        cache_dir=cache_dir,
    )
    return path


@dataclass
class SmartTurnStatus:
    enabled: bool
    loaded: bool
    model: str
    resolved_path: Optional[str]
    sha256: Optional[str]
    error: Optional[str]


class SmartTurnPredictor:
    """Wraps a single ONNX InferenceSession + Whisper feature extractor."""

    def __init__(self, model_path: str):
        import onnxruntime as ort
        from transformers import WhisperFeatureExtractor

        so = ort.SessionOptions()
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._session = ort.InferenceSession(model_path, sess_options=so)
        self._fe = WhisperFeatureExtractor(chunk_length=int(settings.smart_turn_window_s))
        self._window_s = settings.smart_turn_window_s
        self._sample_rate = settings.smart_turn_sample_rate

    def predict(self, audio: np.ndarray) -> float:
        """Return P(turn complete) in [0, 1]. Audio is 16kHz mono float32."""
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32, copy=False)

        audio = _truncate_to_last_n_seconds(
            audio, self._window_s, self._sample_rate
        )

        inputs = self._fe(
            audio,
            sampling_rate=self._sample_rate,
            return_tensors="np",
            padding="max_length",
            max_length=int(self._window_s * self._sample_rate),
            truncation=True,
            do_normalize=True,
        )
        input_features = inputs.input_features.squeeze(0).astype(np.float32)
        input_features = np.expand_dims(input_features, axis=0)

        outputs = self._session.run(None, {"input_features": input_features})
        return float(outputs[0][0].item())


class SmartTurnPool:
    """Process-global singleton: one predictor + one bounded executor."""

    def __init__(self):
        self.status = SmartTurnStatus(
            enabled=settings.smart_turn_enabled,
            loaded=False,
            model=settings.smart_turn_model,
            resolved_path=None,
            sha256=None,
            error=None,
        )
        self._predictor: Optional[SmartTurnPredictor] = None
        self._executor: Optional[concurrent.futures.ThreadPoolExecutor] = None

    def initialize(self) -> None:
        """Eagerly load the model + start the executor. Safe to call once at startup."""
        if not settings.smart_turn_enabled:
            logger.info("[smart-turn] disabled by config (ASR_SMART_TURN_ENABLED=false)")
            return

        try:
            path = resolve_model_path()
            digest = _sha256_file(path)
            size_mb = os.path.getsize(path) / (1 << 20)
            logger.info(
                "[smart-turn] loading ONNX: path=%s size=%.1fMB sha256=%s",
                path, size_mb, digest,
            )
            self._predictor = SmartTurnPredictor(path)
            self._executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=settings.smart_turn_max_concurrency,
                thread_name_prefix="smart-turn",
            )
            self.status.loaded = True
            self.status.resolved_path = path
            self.status.sha256 = digest
            logger.info(
                "[smart-turn] ready — concurrency=%d threshold=%.2f trigger_silence=%dms",
                settings.smart_turn_max_concurrency,
                settings.smart_turn_complete_threshold,
                settings.smart_turn_trigger_silence_ms,
            )
        except Exception as e:
            self.status.error = str(e)
            logger.exception("[smart-turn] FAILED to initialize — Smart Turn disabled")

    def submit(self, audio: np.ndarray) -> Optional[concurrent.futures.Future]:
        """Schedule an inference job. Returns a Future, or None if unavailable."""
        if self._predictor is None or self._executor is None:
            return None
        predictor = self._predictor
        return self._executor.submit(predictor.predict, audio)

    def shutdown(self) -> None:
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None


_pool: Optional[SmartTurnPool] = None


def get_pool() -> SmartTurnPool:
    global _pool
    if _pool is None:
        _pool = SmartTurnPool()
    return _pool
