"""Engine interface for pluggable ASR backends."""
from __future__ import annotations

import numpy as np


class EngineBusyError(Exception):
    """Engine is saturated; mapped to inference_queue_full error event."""


class Engine:
    label: str = "unknown"

    async def start(self) -> None:
        """One-time init: load model / open HTTP client."""

    async def transcribe(self, audio: np.ndarray, sample_rate: int) -> dict:
        """Return {"text": str, "latencyMs": int}. Empty text allowed."""
        raise NotImplementedError

    def health(self) -> dict:
        """Engine-specific fields for /healthz."""
        return {}

    def ready_payload(self) -> dict:
        """Fields for WS ready message."""
        return {"engine": self.label, "vulkan": False}