"""Silero VAD wrapper with per-stream state machine."""
from __future__ import annotations
import logging
from typing import NamedTuple

import numpy as np
import torch
from silero_vad import load_silero_vad

from .config import settings

logger = logging.getLogger(__name__)

FRAME_SIZE = 512


class Segment(NamedTuple):
    start_sample: int
    end_sample: int


class VadState:
    def __init__(self, stream_id: int):
        self.stream_id = stream_id
        self._model = load_silero_vad()
        self._in_speech: bool = False
        self._speech_start_sample: int = 0
        self._last_speech_sample: int = 0
        self._pad_samples = int(settings.vad_speech_pad_ms * settings.sample_rate / 1000)
        self._min_silence_samples = int(settings.vad_min_silence_ms * settings.sample_rate / 1000)
        self._min_speech_samples = int(settings.vad_min_speech_ms * settings.sample_rate / 1000)
        self._max_utterance_samples = int(settings.max_utterance_s * settings.sample_rate)

    def reset(self) -> None:
        self._in_speech = False
        self._speech_start_sample = 0
        self._last_speech_sample = 0
        self._model.reset_states()

    def accept(self, audio: np.ndarray, absolute_start_sample: int) -> list[Segment]:
        segments: list[Segment] = []
        offset = 0
        remaining = len(audio)

        while remaining >= FRAME_SIZE:
            frame = audio[offset : offset + FRAME_SIZE]
            frame_start = absolute_start_sample + offset
            frame_end = frame_start + FRAME_SIZE

            prob = self._model(
                torch.from_numpy(frame.copy()), settings.sample_rate
            ).item()

            if prob >= settings.vad_threshold:
                if not self._in_speech:
                    self._in_speech = True
                    self._speech_start_sample = max(0, frame_start - self._pad_samples)
                self._last_speech_sample = frame_end

            if self._in_speech:
                silence_samples = frame_end - self._last_speech_sample
                duration_samples = frame_end - self._speech_start_sample

                if silence_samples >= self._min_silence_samples:
                    speech_duration = self._last_speech_sample - self._speech_start_sample
                    if speech_duration >= self._min_speech_samples:
                        end = self._last_speech_sample + self._pad_samples
                        segments.append(Segment(self._speech_start_sample, end))
                    self._reset_speech()

                elif duration_samples >= self._max_utterance_samples:
                    segments.append(Segment(self._speech_start_sample, frame_end))
                    self._reset_speech()

            offset += FRAME_SIZE
            remaining -= FRAME_SIZE

        return segments

    def flush(self) -> Segment | None:
        if not self._in_speech:
            return None
        speech_duration = self._last_speech_sample - self._speech_start_sample
        if speech_duration < self._min_speech_samples:
            self._reset_speech()
            return None
        end = self._last_speech_sample + self._pad_samples
        seg = Segment(self._speech_start_sample, end)
        self._reset_speech()
        return seg

    def _reset_speech(self) -> None:
        self._in_speech = False
        self._speech_start_sample = 0
        self._last_speech_sample = 0
        self._model.reset_states()
