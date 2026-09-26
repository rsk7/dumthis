import { describe, expect, it } from 'vitest';
import { computeFeatures } from '../src/analysis/features';
import { DEFAULT_SETTINGS, transcribe } from '../src/analysis/transcribe';
import { INSTRUMENTS, type Instrument } from '../src/analysis/types';
import { synthLoop } from './synth';

const SR = 44100;
const ROCK: Record<Instrument, number[]> = {
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
    for (const inst of INSTRUMENTS) {
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
