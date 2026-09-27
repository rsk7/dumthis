// Runs the in-browser band-split onset detector on audio files and prints the hits as JSON,
// so server/eval.py can score it against the same ground truth as the ML pipeline.
// Usage: npx vite-node scripts/detect-bandsplit.ts file1.wav [file2.wav ...]
import { execFileSync } from 'node:child_process';
import { computeFeatures } from '../src/analysis/features';
import { pickPeaks } from '../src/analysis/peaks';
import { DEFAULT_SETTINGS, sensitivityToDelta } from '../src/analysis/transcribe';

const SAMPLE_RATE = 44100;
const BANDS = ['kick', 'snare', 'hat'] as const;

function decodeMono(path: string): Float32Array {
  const raw = execFileSync(
    'ffmpeg',
    ['-nostdin', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), '-'],
    { maxBuffer: 1 << 30 },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

const out: Record<string, Record<string, number[]>> = {};
for (const path of process.argv.slice(2)) {
  const features = computeFeatures(decodeMono(path), SAMPLE_RATE);
  out[path] = Object.fromEntries(
    BANDS.map((band) => [
      band,
      pickPeaks(features.odf[band], features.fps, sensitivityToDelta(DEFAULT_SETTINGS.sensitivity[band])).map((o) => o.time),
    ]),
  );
}
console.log(JSON.stringify(out));
