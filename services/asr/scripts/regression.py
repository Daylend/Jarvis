"""
Offline regression harness. Runs every WAV under services/asr/fixtures/ through
Transcriber.transcribe_without_streaming() (which still triggers listener events
per the moonshine-voice docs) and asserts:

  1. At least one on_line_completed event fires.
  2. The concatenated final text contains the expected substring from the
     sibling .expect.txt file.

Run with:  docker compose exec asr python /app/scripts/regression.py
"""
from __future__ import annotations

import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
from moonshine_voice import Transcriber, TranscriptEventListener

FIXTURE_DIR = Path(os.environ.get("FIXTURE_DIR", "/app/fixtures"))


class _Capture(TranscriptEventListener):
    def __init__(self) -> None:
        self.partials: list[str] = []
        self.finals: list[str] = []

    def on_line_text_changed(self, event):  # type: ignore[override]
        self.partials.append(event.line.text)

    def on_line_completed(self, event):  # type: ignore[override]
        self.finals.append(event.line.text)


def _read_wav_mono_float32(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        if sw != 2:
            raise RuntimeError(f"{path}: expected 16-bit PCM, got sample width {sw}")
        raw = w.readframes(w.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch == 2:
        audio = audio.reshape(-1, 2).mean(axis=1)
    return audio, sr


def _run_one(wav: Path) -> tuple[bool, str]:
    expect_file = wav.with_suffix(".expect.txt")
    expected = expect_file.read_text().strip().lower() if expect_file.exists() else ""

    audio, sr = _read_wav_mono_float32(wav)
    cap = _Capture()

    transcriber = Transcriber(
        model_path=os.environ["MOONSHINE_MODEL_PATH"],
        model_arch=int(os.environ["MOONSHINE_MODEL_ARCH"]),
        update_interval=float(os.environ.get("MOONSHINE_UPDATE_INTERVAL", "0.25")),
        options={"return_audio_data": "false", "identify_speakers": "false"},
    )
    transcriber.add_listener(cap)
    t0 = time.monotonic()
    transcriber.transcribe_without_streaming(audio, sr)
    transcriber.stop()
    elapsed_ms = (time.monotonic() - t0) * 1000.0

    text = " ".join(cap.finals).strip().lower()
    ok = bool(cap.finals) and (not expected or expected in text)
    print(f"[regression] {wav.name}: ok={ok} finals={len(cap.finals)} elapsed_ms={elapsed_ms:.0f} text={text!r}")
    if expected and expected not in text:
        return False, f"expected substring {expected!r} not in {text!r}"
    if not cap.finals:
        return False, "no on_line_completed events fired"
    return True, ""


def main() -> int:
    if not FIXTURE_DIR.is_dir():
        print(f"[regression] no fixtures at {FIXTURE_DIR}", file=sys.stderr)
        return 0
    wavs = sorted(FIXTURE_DIR.glob("*.wav"))
    if not wavs:
        print(f"[regression] no .wav fixtures under {FIXTURE_DIR}")
        return 0
    failures = 0
    for wav in wavs:
        ok, msg = _run_one(wav)
        if not ok:
            failures += 1
            print(f"[regression] FAIL {wav.name}: {msg}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
