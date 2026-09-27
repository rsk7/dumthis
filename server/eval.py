"""Scores drum transcription against MDB Drums ground truth.

Compares ADTOF on the full mix, ADTOF on the Demucs drum stem, and the in-browser
band-split detector. Prints onset F-measure (50 ms window) per instrument.

MDB Drums (CC BY-NC-SA 4.0) is not part of this repo. Download the tracks first:

    cd server/.cache && mkdir -p mdb/audio mdb/annotations && cd mdb
    B="https://raw.githubusercontent.com/CarlSouthall/MDBDrums/master/MDB%20Drums"
    for t in 80sRock Beatles Britpop Country1 Disco Gospel Grunge Hendrix Punk Reggae Rock \
             Rockabilly Shadows SpeedMetal Zeppelin; do
      curl -sfL "$B/audio/full_mix/MusicDelta_${t}_MIX.wav" -o "audio/MusicDelta_${t}_MIX.wav"
      curl -sfL "$B/annotations/class/MusicDelta_${t}_class.txt" -o "annotations/MusicDelta_${t}_class.txt"
    done

Usage (from the repo root):
    npm run eval
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import mir_eval
import numpy as np
import soundfile as sf

from pipeline import ADTOF_FPS, SAMPLE_RATE, Pipeline, decode_audio

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
MDB = ROOT / ".cache" / "mdb"
# MDB class codes -> our instrument names.
MDB_CLASSES = {"KD": "kick", "SD": "snare", "HH": "hat", "TT": "tomlow", "CY": "crash"}
# ADTOF's published per-class thresholds (kick, snare, toms, hi-hat, cymbals).
THRESHOLDS = {"kick": 0.22, "snare": 0.24, "tomlow": 0.32, "hat": 0.22, "crash": 0.30}
INSTRUMENTS = ["kick", "snare", "hat", "tomlow", "crash"]
WINDOW = 0.05


def load_truth(path: Path) -> dict[str, np.ndarray]:
    hits = defaultdict(list)
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] in MDB_CLASSES:
            hits[MDB_CLASSES[parts[1]]].append(float(parts[0]))
    return {inst: np.array(sorted(hits[inst])) for inst in INSTRUMENTS}


def adtof_hits(result: dict[str, list[list[float]]]) -> dict[str, np.ndarray]:
    return {inst: np.array([t for t, c in result[inst] if c >= THRESHOLDS[inst]]) for inst in INSTRUMENTS}


def band_split_hits(files: list[Path]) -> dict[str, dict[str, np.ndarray]]:
    out = subprocess.run(
        ["npx", "vite-node", "scripts/detect-bandsplit.ts", *map(str, files)],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out.strip().splitlines()[-1])
    return {
        Path(f).name: {inst: np.array(data[f].get(inst, [])) for inst in INSTRUMENTS}
        for f in data
    }


def f_measure(truth: np.ndarray, est: np.ndarray) -> tuple[int, int, int]:
    """Returns (true positives, false positives, false negatives)."""
    if len(truth) == 0 and len(est) == 0:
        return 0, 0, 0
    matched = len(mir_eval.util.match_events(truth, est, WINDOW)) if len(truth) and len(est) else 0
    return matched, len(est) - matched, len(truth) - matched


def main() -> None:
    tracks = sorted((MDB / "audio").glob("*_MIX.wav"))
    if not tracks:
        sys.exit(f"No tracks in {MDB / 'audio'}; see the module docstring.")

    pipeline = Pipeline()
    systems = ["adtof-mix", "adtof-drums", "band-split"]
    totals = {s: {i: [0, 0, 0] for i in INSTRUMENTS} for s in systems}
    stems = MDB / "stems"
    stems.mkdir(exist_ok=True)

    print("Band-split baseline…", flush=True)
    baseline = band_split_hits(tracks)

    for track in tracks:
        name = track.name.removesuffix("_MIX.wav")
        truth = load_truth(MDB / "annotations" / f"{name}_class.txt")
        drums_path = stems / f"{name}_drums.wav"
        if not drums_path.exists():
            drums = pipeline.separate_drums(decode_audio(track), lambda *_: None)
            sf.write(drums_path, drums.T, SAMPLE_RATE)
        estimates = {
            "adtof-mix": adtof_hits(pipeline.transcribe_drums(track)),
            "adtof-drums": adtof_hits(pipeline.transcribe_drums(drums_path)),
            "band-split": baseline[track.name],
        }
        row = []
        for system in systems:
            for inst in INSTRUMENTS:
                tp, fp, fn = f_measure(truth[inst], estimates[system][inst])
                for k, v in enumerate((tp, fp, fn)):
                    totals[system][inst][k] += v
            kick_snare = [f_measure(truth[i], estimates[system][i]) for i in ("kick", "snare")]
            tp = sum(x[0] for x in kick_snare)
            fp = sum(x[1] for x in kick_snare)
            fn = sum(x[2] for x in kick_snare)
            row.append(f"{system} {2 * tp / max(1, 2 * tp + fp + fn):.2f}")
        print(f"{name:28s} kick+snare F: " + "  ".join(row), flush=True)

    print(f"\nOnset F-measure over {len(tracks)} tracks (±{int(WINDOW * 1000)} ms), precision/recall in brackets:")
    print(f"{'':12s}" + "".join(f"{i:>22s}" for i in INSTRUMENTS))
    for system in systems:
        cells = []
        for inst in INSTRUMENTS:
            tp, fp, fn = totals[system][inst]
            if inst in ("tomlow", "crash") and system == "band-split":
                cells.append(f"{'n/a':>22s}")
                continue
            p = tp / max(1, tp + fp)
            r = tp / max(1, tp + fn)
            f = 2 * tp / max(1, 2 * tp + fp + fn)
            cells.append(f"{f:>9.2f} ({p:.2f}/{r:.2f})")
        print(f"{system:12s}" + "".join(cells))


if __name__ == "__main__":
    main()
