import { describe, expect, it } from 'vitest';
import { BAND_INSTRUMENTS, computeFeatures, type BandInstrument } from '../src/analysis/features';
import {
  DEFAULT_SETTINGS,
  arrange,
  detectionFromServer,
  sensitivityToConfidence,
  transcribe,
  type ServerHits,
} from '../src/analysis/transcribe';
import { synthLoop } from './synth';

const SR = 44100;
const ROCK: Record<BandInstrument, number[]> = {
  kick: [0, 8, 10],
  snare: [4, 12],
  hat: [0, 2, 4, 6, 8, 10, 12, 14],
};

function activeSteps(values: number[]): number[] {
  return values.flatMap((v, i) => (v > 0 ? [i] : []));
}

describe.each([
  { bpm: 120, bass: false },
  { bpm: 120, bass: true },
  { bpm: 97, bass: true },
  { bpm: 142, bass: false },
])('synthetic rock beat at $bpm BPM (bass: $bass)', ({ bpm, bass }) => {
  const lead = 0.5;
  const audio = synthLoop({ bpm, bars: 16, lead, pattern: ROCK, bass, sampleRate: SR });
  const tx = transcribe(computeFeatures(audio, SR), DEFAULT_SETTINGS);

  it('estimates the tempo', () => {
    expect(tx.bpm).toBeGreaterThan(bpm * 0.98);
    expect(tx.bpm).toBeLessThan(bpm * 1.02);
  });

  it('puts the first bar on the first downbeat', () => {
    expect(tx.bars.length).toBeGreaterThanOrEqual(14);
    expect(Math.abs(tx.bars[0].startTime - lead)).toBeLessThan(0.02);
  });

  it('recovers the pattern', () => {
    expect(activeSteps(tx.consensus.tomlow)).toEqual([]);
    expect(activeSteps(tx.consensus.crash)).toEqual([]);
    for (const inst of BAND_INSTRUMENTS) {
      const found = activeSteps(tx.consensus[inst]);
      if (inst === 'kick' && bass) {
        // Known limit of band splitting: bass notes land in the kick band and add false kicks.
        expect(found, inst).toEqual(expect.arrayContaining(ROCK.kick));
      } else {
        expect(found, inst).toEqual(ROCK[inst]);
      }
    }
  });
});

describe('server results', () => {
  // 120 BPM, 8 bars; the track starts with a one-beat pickup, so bar 1 begins on the second beat.
  const beat = 0.5;
  const beats = Array.from({ length: 33 }, (_, i) => 1 + i * beat);
  const downbeats = beats.filter((_, i) => i % 4 === 1);
  const at = (bar: number, step: number) => downbeats[bar] + (step * beat) / 4;
  const hits = (steps: number[], confidence: number): [number, number][] =>
    Array.from({ length: 7 }, (_, bar) => steps.map((s): [number, number] => [at(bar, s), confidence])).flat();
  const result: ServerHits = {
    beats,
    downbeats,
    hits: {
      kick: hits([0, 8, 10], 0.9),
      snare: hits([4, 12], 0.8),
      hat: hits([0, 2, 4, 6, 8, 10, 12, 14], 0.6),
      // Unsure toms: below the default threshold, above it at high sensitivity.
      tomlow: hits([14], 0.3),
      crash: [[at(0, 0), 0.7]],
    },
  };

  it('uses the server downbeats for bar starts', () => {
    const tx = arrange(detectionFromServer(result, DEFAULT_SETTINGS), DEFAULT_SETTINGS);
    expect(tx.phase).toBe(1);
    expect(tx.bars[0].startTime).toBeCloseTo(downbeats[0]);
    expect(tx.bpm).toBeCloseTo(120);
    expect(activeSteps(tx.consensus.kick)).toEqual(ROCK.kick);
    expect(activeSteps(tx.consensus.snare)).toEqual(ROCK.snare);
    expect(activeSteps(tx.consensus.hat)).toEqual(ROCK.hat);
    expect(activeSteps(tx.bars[0].pattern.crash)).toEqual([0]);
  });

  it('applies sensitivity as a confidence threshold', () => {
    const strict = arrange(detectionFromServer(result, DEFAULT_SETTINGS), DEFAULT_SETTINGS);
    expect(activeSteps(strict.consensus.tomlow)).toEqual([]);
    const loose = { ...DEFAULT_SETTINGS, sensitivity: { ...DEFAULT_SETTINGS.sensitivity, tomlow: 80 } };
    expect(sensitivityToConfidence('tomlow', 80)).toBeLessThan(0.3);
    expect(activeSteps(arrange(detectionFromServer(result, loose), loose).consensus.tomlow)).toEqual([14]);
  });

  it('halves and doubles the beat grid', () => {
    const half = { ...DEFAULT_SETTINGS, beatScale: 0.5 };
    const txHalf = arrange(detectionFromServer(result, half), half);
    expect(txHalf.bpm).toBeCloseTo(60);
    expect(txHalf.bars[0].startTime).toBeCloseTo(downbeats[0]);

    const double = { ...DEFAULT_SETTINGS, beatScale: 2 };
    expect(arrange(detectionFromServer(result, double), double).bpm).toBeCloseTo(240);
  });
});
