import { biquad } from '../src/analysis/dsp';
import type { BandInstrument } from '../src/analysis/features';

export interface SynthOptions {
  bpm: number;
  bars: number;
  /** Silence before the first downbeat, seconds. */
  lead: number;
  pattern: Record<BandInstrument, number[]>;
  /** Adds a sustained bass line that changes note on every beat. */
  bass?: boolean;
  sampleRate?: number;
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Renders a simple synthetic drum loop with known hit positions. */
export function synthLoop(opts: SynthOptions): Float32Array {
  const sr = opts.sampleRate ?? 44100;
  const stepDur = 60 / opts.bpm / 4;
  const out = new Float32Array(Math.ceil((opts.lead + opts.bars * 16 * stepDur + 1) * sr));
  const rand = rng(1);
  const noise = (len: number) => Float32Array.from({ length: len }, () => rand() * 2 - 1);
  const hatNoise = biquad(biquad(noise(sr), sr, 'highpass', 8000), sr, 'highpass', 8000);

  const addKick = (start: number) => {
    let phase = 0;
    for (let n = 0; n < 0.3 * sr && start + n < out.length; n++) {
      const t = n / sr;
      phase += (2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03))) / sr;
      out[start + n] += 0.9 * Math.exp(-t / 0.12) * Math.sin(phase);
    }
  };
  const addSnare = (start: number) => {
    for (let n = 0; n < 0.25 * sr && start + n < out.length; n++) {
      const t = n / sr;
      out[start + n] += 0.5 * Math.exp(-t / 0.06) * (rand() * 2 - 1) + 0.3 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * 190 * t);
    }
  };
  const addHat = (start: number) => {
    for (let n = 0; n < 0.08 * sr && start + n < out.length; n++) {
      out[start + n] += 0.3 * Math.exp(-n / sr / 0.02) * hatNoise[n];
    }
  };
  const voices: Record<BandInstrument, (start: number) => void> = { kick: addKick, snare: addSnare, hat: addHat };

  for (let bar = 0; bar < opts.bars; bar++) {
    for (const inst of Object.keys(voices) as BandInstrument[]) {
      for (const step of opts.pattern[inst]) {
        voices[inst](Math.round((opts.lead + (bar * 16 + step) * stepDur) * sr));
      }
    }
  }

  if (opts.bass) {
    const notes = [55, 55, 65.4, 73.4];
    const beatDur = stepDur * 4;
    for (let beat = 0; beat < opts.bars * 4; beat++) {
      const start = Math.round((opts.lead + beat * beatDur) * sr);
      const freq = notes[beat % notes.length];
      for (let n = 0; n < beatDur * sr && start + n < out.length; n++) {
        const t = n / sr;
        out[start + n] += 0.3 * Math.min(1, t / 0.02) * Math.sin(2 * Math.PI * freq * t);
      }
    }
  }
  return out;
}
