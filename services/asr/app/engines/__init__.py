"""Lazy engine singleton — only loads the selected engine's dependencies."""
from __future__ import annotations

from .base import Engine, EngineBusyError
from ..config import settings

_engine: Engine | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        eng = settings.engine.lower()
        if eng == "whisper":
            from .whisper import WhisperEngine
            _engine = WhisperEngine()
        elif eng in ("granite", "openai"):
            from .granite import GraniteEngine
            _engine = GraniteEngine()
        else:
            raise ValueError(f"Unknown ASR_ENGINE={settings.engine!r}")
    return _engine