"""Drum transcription pipeline.

1. Demucs (htdemucs) separates the drum stem from the mix.
2. beat-this finds beats and downbeats on the full mix.
3. ADTOF (Frame_RNN, PyTorch port) detects kick / snare / toms / hi-hat / cymbal hits.

Every hit is returned with the model's confidence, so the frontend can apply its own
threshold (the sensitivity sliders) without re-running anything.
"""

from __future__ import annotations

import os

# Some Demucs ops are not implemented on Apple's MPS backend; let torch fall back to CPU for those.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import certifi

# The python.org macOS build ships without CA certificates, which breaks model downloads over HTTPS.
os.environ.setdefault("SSL_CERT_FILE", certifi.where())

import logging
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Literal

import numpy as np
import soundfile as sf
import torch

log = logging.getLogger("dumthis.pipeline")

PIPELINE_VERSION = 1
SAMPLE_RATE = 44100
ADTOF_FPS = 100
# ADTOF output order is MIDI notes 35, 38, 47, 42, 49. Names match the frontend's instruments.
ADTOF_CLASSES = ["kick", "snare", "tomlow", "hat", "crash"]
# Hits below this confidence are dropped server-side; the frontend thresholds above it.
CONFIDENCE_FLOOR = 0.08

# stage name, fraction of that stage done (0..1)
ProgressFn = Callable[[str, float], None]
TranscriptionSource = Literal["drums", "mix"]


def default_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def decode_audio(path: Path, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Decodes any format ffmpeg understands to float32 stereo, shape (2, samples)."""
    cmd = [
        "ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
        "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(sample_rate), "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise ValueError(f"ffmpeg could not decode the file: {proc.stderr.decode(errors='replace').strip()}")
    audio = np.frombuffer(proc.stdout, dtype=np.float32).reshape(-1, 2).T.copy()
    if audio.shape[1] == 0:
        raise ValueError("The file contains no audio.")
    return audio


class Pipeline:
    """Holds the loaded models. Not thread-safe; run one job at a time."""

    def __init__(self, device: str | None = None):
        self.device = device or default_device()
        self._separator = None
        self._beats = None
        self._adtof = None
        self._lock = threading.Lock()

    # ---------- Models (loaded lazily, kept in memory) ----------

    def _get_separator(self):
        if self._separator is None:
            from demucs.api import Separator

            self._separator = Separator(model="htdemucs", device=self.device)
        return self._separator

    def _get_beat_tracker(self):
        if self._beats is None:
            from beat_this.inference import Audio2Beats

            # beat-this is small; CPU keeps it clear of MPS quirks.
            device = "cuda" if self.device == "cuda" else "cpu"
            self._beats = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)
        return self._beats

    def _get_adtof(self):
        if self._adtof is None:
            from adtof_pytorch import (
                calculate_n_bins,
                create_frame_rnn_model,
                get_default_weights_path,
                load_pytorch_weights,
            )

            model = create_frame_rnn_model(calculate_n_bins())
            model = load_pytorch_weights(model, get_default_weights_path(), strict=False)
            model.eval()
            self._adtof = model
        return self._adtof

    # ---------- Stages ----------

    def separate_drums(self, mix: np.ndarray, progress: ProgressFn) -> np.ndarray:
        separator = self._get_separator()
        total = mix.shape[1]

        def on_chunk(info: dict) -> None:
            if info.get("state") == "end":
                progress("separating", min(1.0, info.get("segment_offset", 0) / total))

        separator.update_parameter(callback=on_chunk)
        wav = torch.from_numpy(mix)
        try:
            _, stems = separator.separate_tensor(wav, SAMPLE_RATE)
        except RuntimeError as err:
            if self.device == "cpu":
                raise
            log.warning("Demucs failed on %s (%s); retrying on CPU", self.device, err)
            separator.update_parameter(device="cpu")
            _, stems = separator.separate_tensor(wav, SAMPLE_RATE)
        drums = stems["drums"].cpu().numpy()
        if separator.samplerate != SAMPLE_RATE:
            raise RuntimeError(f"Unexpected Demucs sample rate {separator.samplerate}")
        return drums

    def track_beats(self, mix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        beats, downbeats = self._get_beat_tracker()(mix.mean(axis=0), SAMPLE_RATE)
        return np.asarray(beats, dtype=float), np.asarray(downbeats, dtype=float)

    def transcribe_drums(self, audio_path: Path) -> dict[str, list[list[float]]]:
        from adtof_pytorch import load_audio_for_model
        from adtof_pytorch.post_processing import NotePeakPickingProcessor

        model = self._get_adtof()
        with torch.no_grad():
            activations = model(load_audio_for_model(str(audio_path))).cpu().numpy()[0]  # (frames, 5)

        # Same peak picking parameters as ADTOF, but with a low threshold; confidence is kept per hit.
        picker = NotePeakPickingProcessor(
            threshold=CONFIDENCE_FLOOR, pre_avg=0.1, post_avg=0.01, pre_max=0.02, post_max=0.01,
            combine=0.02, fps=ADTOF_FPS,
        )
        hits: dict[str, list[list[float]]] = {}
        for i, name in enumerate(ADTOF_CLASSES):
            act = activations[:, i]
            out = []
            for t, _ in picker.process(act):
                frame = int(round(t * ADTOF_FPS))
                confidence = float(act[max(0, frame - 1): frame + 2].max())
                out.append([round(t, 4), round(confidence, 4)])
            hits[name] = out
        return hits

    # ---------- Full run ----------

    def run(
        self,
        input_path: Path,
        out_dir: Path,
        progress: ProgressFn,
        source: TranscriptionSource = "drums",
    ) -> dict:
        """Analyzes one file. Writes drums.flac into out_dir and returns the result as a dict."""
        with self._lock:
            timings: dict[str, float] = {}

            def timed(stage: str, fn):
                progress(stage, 0.0)
                t0 = time.perf_counter()
                value = fn()
                timings[stage] = round(time.perf_counter() - t0, 2)
                progress(stage, 1.0)
                return value

            mix = timed("decoding", lambda: decode_audio(input_path))
            drums = timed("separating", lambda: self.separate_drums(mix, progress))
            drums_path = out_dir / "drums.flac"
            sf.write(drums_path, drums.T, SAMPLE_RATE)
            beats, downbeats = timed("beats", lambda: self.track_beats(mix))

            if source == "mix":
                mix_path = out_dir / "mix.wav"
                sf.write(mix_path, mix.T, SAMPLE_RATE)
                hits = timed("transcribing", lambda: self.transcribe_drums(mix_path))
                mix_path.unlink()
            else:
                hits = timed("transcribing", lambda: self.transcribe_drums(drums_path))

            return {
                "version": PIPELINE_VERSION,
                "duration": round(mix.shape[1] / SAMPLE_RATE, 3),
                "beats": [round(float(b), 4) for b in beats],
                "downbeats": [round(float(d), 4) for d in downbeats],
                "hits": hits,
                "source": source,
                "device": self.device,
                "timings": timings,
                "models": {"separation": "htdemucs", "beats": "beat-this final0", "drums": "ADTOF Frame_RNN"},
            }
