"""Silero VAD wrapper with per-stream state machine."""
from __future__ import annotations
import logging
from typing import Callable, NamedTuple, Optional

import numpy as np
import torch
from silero_vad import load_silero_vad

from .config import settings

logger = logging.getLogger(__name__)

FRAME_SIZE = 512


class Segment(NamedTuple):
    start_sample: int
    end_sample: int
    # Unpadded voiced span (real onset frame .. last voiced frame_end) and the
    # Silero prob at onset. Used downstream to compute voiced-core duration and
    # to detect hallucinated text disproportionate to actual voicing. The
    # padded start_sample/end_sample are still what gets sliced for transcription.
    voiced_start_sample: int = 0
    voiced_end_sample: int = 0
    onset_prob: float = 0.0


class VadState:
    def __init__(self, stream_id: int, smart_turn_enabled: bool = False):
        self.stream_id = stream_id
        self._model = load_silero_vad()
        self._in_speech: bool = False
        self._speech_start_sample: int = 0
        self._last_speech_sample: int = 0
        # Real onset frame (unpadded) + the Silero prob there. Captured at
        # speech START so downstream can measure the voiced core independent of
        # the padded segment span, and log onset confidence.
        self._onset_sample: int = 0
        self._onset_prob: float = 0.0
        # Logical turn anchor. A Smart Turn provisional close reopens the turn
        # (speech may resume); the anchor is the ORIGINAL speech start of the
        # turn, preserved across provisional reopens so the eventual definitive
        # close slices the full utterance — including any prefix that was
        # transcribed-then-dropped on a false "turn complete". Reset only when
        # the turn truly ends (definitive close, or a provisional that commits).
        self._turn_open: bool = False
        self._pad_samples = int(settings.vad_speech_pad_ms * settings.sample_rate / 1000)
        self._min_silence_samples = int(settings.vad_min_silence_ms * settings.sample_rate / 1000)
        self._min_speech_samples = int(settings.vad_min_speech_ms * settings.sample_rate / 1000)
        self._max_utterance_samples = int(settings.max_utterance_s * settings.sample_rate)
        self._remainder = np.empty(0, dtype=np.float32)

        # Smart Turn integration. Only active when the caller confirms the model
        # actually loaded — if the ONNX failed to load at startup we fall back to
        # the plain min-silence close so endpointing isn't left to the hard
        # fallback alone. When enabled, the plain min-silence auto-close is
        # suppressed (Smart Turn / watchdog hard-silence / max-utterance own all
        # closes); at trigger_silence_samples of silence the VAD invokes
        # on_trigger_silence so the stream can run a Smart Turn job.
        self._smart_turn_enabled = smart_turn_enabled
        self._trigger_silence_samples = int(
            settings.smart_turn_trigger_silence_ms * settings.sample_rate / 1000
        )
        self._on_trigger_silence: Optional[Callable[[int], None]] = None
        self._triggered_this_silence: bool = False

    def set_trigger_silence_callback(self, cb: Callable[[int], None]) -> None:
        self._on_trigger_silence = cb

    def _segment(self, start: int, end: int) -> Segment:
        """Build a Segment carrying the padded span plus the unpadded voiced
        core (onset .. last_speech) and onset prob. Must be called BEFORE any
        reset of the speech flags, while the current run's state is intact."""
        return Segment(
            start_sample=start,
            end_sample=end,
            voiced_start_sample=self._onset_sample,
            voiced_end_sample=self._last_speech_sample,
            onset_prob=self._onset_prob,
        )

    def reset(self) -> None:
        self._reset_speech_flags()
        self._remainder = np.empty(0, dtype=np.float32)
        self._model.reset_states()

    def accept(self, audio: np.ndarray, absolute_start_sample: int) -> list[Segment]:
        segments: list[Segment] = []

        if len(self._remainder) > 0:
            absolute_start_sample -= len(self._remainder)
            audio = np.concatenate([self._remainder, audio])
            self._remainder = np.empty(0, dtype=np.float32)

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
                    if not self._turn_open:
                        # Fresh logical turn — capture the anchor. When resuming
                        # within an already-open turn (after a provisional close
                        # whose prefix we must recover), keep the original anchor
                        # so a later close slices the full utterance.
                        self._speech_start_sample = max(0, frame_start - self._pad_samples)
                        self._onset_sample = frame_start
                        self._onset_prob = prob
                        self._turn_open = True
                    logger.info("[vad %d] speech START at sample %d (prob=%.3f)",
                                self.stream_id, frame_start, prob)
                self._last_speech_sample = frame_end
                # New speech invalidates any pending Smart Turn trigger for this
                # silence run — a fresh silence must accumulate before retriggering.
                self._triggered_this_silence = False

            if self._in_speech:
                silence_samples = frame_end - self._last_speech_sample
                duration_samples = frame_end - self._speech_start_sample

                # Smart Turn trigger: enough silence to consider the turn, but
                # not enough to hard-close. Let the stream run an inference job.
                if (
                    self._smart_turn_enabled
                    and not self._triggered_this_silence
                    and self._on_trigger_silence is not None
                    and silence_samples >= self._trigger_silence_samples
                ):
                    self._triggered_this_silence = True
                    try:
                        self._on_trigger_silence(frame_end)
                    except Exception:
                        logger.exception("[vad %d] on_trigger_silence callback failed",
                                         self.stream_id)

                if silence_samples >= self._min_silence_samples:
                    speech_duration = self._last_speech_sample - self._speech_start_sample
                    if speech_duration >= self._min_speech_samples:
                        if self._smart_turn_enabled:
                            # Smart Turn / watchdog own the closes; keep listening.
                            pass
                        else:
                            end = self._last_speech_sample + self._pad_samples
                            segments.append(self._segment(self._speech_start_sample, end))
                            logger.info("[vad %d] segment emitted: %d-%d (%.1fs)",
                                        self.stream_id, self._speech_start_sample, end,
                                        (end - self._speech_start_sample) / settings.sample_rate)
                            self._reset_speech()
                    else:
                        # Too short to be real speech — drop the blip (matches
                        # the pre-Smart-Turn behavior for sub-min-speech bursts).
                        self._reset_speech()

                elif duration_samples >= self._max_utterance_samples:
                    segments.append(self._segment(self._speech_start_sample, frame_end))
                    logger.info("[vad %d] max utt segment: %d-%d (%.1fs)",
                                self.stream_id, self._speech_start_sample, frame_end,
                                duration_samples / settings.sample_rate)
                    self._reset_speech()

            offset += FRAME_SIZE
            remaining -= FRAME_SIZE

        if remaining > 0:
            self._remainder = audio[offset:].copy()

        return segments

    def flush(self) -> Segment | None:
        if not self._in_speech:
            return None
        speech_duration = self._last_speech_sample - self._speech_start_sample
        if speech_duration < self._min_speech_samples:
            self._reset_speech()
            return None
        end = self._last_speech_sample + self._pad_samples
        seg = self._segment(self._speech_start_sample, end)
        self._reset_speech()
        return seg

    def force_close_segment(self, *, provisional: bool = False) -> Segment | None:
        """Close the current speech segment immediately (Smart Turn candidate /
        watchdog hard-silence). Returns None if not in speech or too short.

        When `provisional` is True (a revocable Smart Turn close), the Silero
        RNN states are NOT reset. A wrong "turn complete" guess must not clip
        the leading audio of resumed speech: warm states re-detect the next
        voiced frame immediately instead of ramping from a reset baseline (the
        cold-start onset gap that drops leading consonants). A subsequent
        definitive close (hard-silence, max-utt, flush) still does the full
        reset, so state never leaks across truly-separate utterances.

        The turn anchor is also preserved on a provisional close: a resumed run
        keeps the original speech start so the eventual definitive transcription
        covers the full utterance (no orphaned prefix when a false "turn
        complete" is dropped). Only `_in_speech` and the silence trigger flag
        are cleared.
        """
        if not self._in_speech:
            return None
        speech_duration = self._last_speech_sample - self._speech_start_sample
        if speech_duration < self._min_speech_samples:
            self._reset_speech()
            return None
        end = self._last_speech_sample + self._pad_samples
        seg = self._segment(self._speech_start_sample, end)
        logger.info("[vad %d] force-close segment: %d-%d (%.1fs)%s",
                    self.stream_id, self._speech_start_sample, end,
                    (end - self._speech_start_sample) / settings.sample_rate,
                    " [provisional, states preserved]" if provisional else "")
        if provisional:
            self._soft_reset_speech_flags()
        else:
            self._reset_speech()
        return seg

    def end_turn(self) -> None:
        """End the logical turn without emitting a VAD segment — used when a
        provisional final commits via the Smart Turn grace window (no reopen).
        Clears the anchor so the next utterance captures a fresh start instead
        of merging into the already-committed one. Leaves Silero RNN states and
        `_in_speech` untouched (a committed provisional already exited speech)."""
        self._turn_open = False
        self._speech_start_sample = 0
        self._onset_sample = 0
        self._onset_prob = 0.0
        self._last_speech_sample = 0

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    @property
    def speech_start_sample(self) -> int:
        return self._speech_start_sample

    @property
    def last_speech_sample(self) -> int:
        return self._last_speech_sample

    def _soft_reset_speech_flags(self) -> None:
        """Provisional close: leave the logical turn open. Only exit the
        in-speech run (so Silero warm states can re-detect resumed speech) and
        re-arm the silence trigger. The turn anchor is preserved so a later
        close recovers any prefix transcribed-then-dropped on a false 'turn
        complete'."""
        self._in_speech = False
        self._triggered_this_silence = False

    def _reset_speech_flags(self) -> None:
        self._in_speech = False
        self._speech_start_sample = 0
        self._last_speech_sample = 0
        self._onset_sample = 0
        self._onset_prob = 0.0
        self._triggered_this_silence = False
        self._turn_open = False

    def _reset_speech(self) -> None:
        self._reset_speech_flags()
        self._model.reset_states()
