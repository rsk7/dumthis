import { BAND_INSTRUMENTS, type Features } from './features';
import { pickPeaks, type Onset } from './peaks';
import { estimatePeriod, trackBeats } from './tempo';
import {
  BEATS_PER_BAR,
  INSTRUMENTS,
  STEPS_PER_BAR,
  STEPS_PER_BEAT,
  emptyPattern,
  perInstrument,
  type Instrument,
  type Pattern,
  type PerInstrument,
} from './types';
import { clamp, median, mod, nearestIndex, quantile } from './util';

export interface Settings {
  /** 0..100 per instrument; higher picks up quieter / less certain hits. */
  sensitivity: PerInstrument<number>;
  /** Manual tempo override for the in-browser tracker; null lets it estimate. */
  bpm: number | null;
  /** Server results only: 2 doubles the beat grid, 0.5 halves it. */
  beatScale: number;
  /** Beats to shift the detected bar start by. */
  downbeatShift: number;
  /** Fraction of bars a step must be hit in to make it into the consensus pattern. */
  consensusThreshold: number;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: perInstrument(() => 50),
  bpm: null,
  beatScale: 1,
  downbeatShift: 0,
  consensusThreshold: 0.4,
};

export interface Bar {
  index: number;
  startStep: number;
  startTime: number;
  pattern: Pattern;
  hits: number;
}

export interface Transcription {
  bpm: number;
  beatTimes: number[];
  /** Time of every 16th-note step, interpolated between tracked beats. */
  stepTimes: number[];
  onsets: PerInstrument<Onset[]>;
  /** Quantized velocity per step, same length as stepTimes. */
  steps: PerInstrument<Float32Array>;
  /** Index (0..3) of the first tracked beat that starts a bar. */
  phase: number;
  bars: Bar[];
  consensus: Pattern;
}

/** Hits and beats from either detector, before they are put on a grid. */
export interface Detection {
  onsets: PerInstrument<Onset[]>;
  beatTimes: number[];
  /** Known downbeats (from the server's beat tracker); otherwise guessed from the drums. */
  downbeatTimes?: number[];
  /** Drop weak hits that coincide with strong ones in a neighboring band (band-split bleed). */
  suppressBleed: boolean;
}

/** Hits as returned by the local server: [time in seconds, model confidence 0..1]. */
export interface ServerHits {
  beats: number[];
  downbeats: number[];
  hits: PerInstrument<[number, number][]>;
}

export function sensitivityToDelta(sensitivity: number): number {
  return 0.3 + (1 - clamp(sensitivity, 0, 100) / 100) * 3;
}

/**
 * ADTOF's published per-class thresholds, except toms: the model over-reports them
 * (precision 0.32 on MDB Drums at 0.32), so they start stricter.
 */
export const SERVER_THRESHOLDS: PerInstrument<number> = { kick: 0.22, snare: 0.24, hat: 0.22, tomlow: 0.5, crash: 0.3 };
const SERVER_CONFIDENCE_FLOOR = 0.08;

/** Sensitivity 50 = default threshold; every 25 points halves (more hits) or doubles it. */
export function sensitivityToConfidence(inst: Instrument, sensitivity: number): number {
  const threshold = SERVER_THRESHOLDS[inst] * 2 ** ((50 - clamp(sensitivity, 0, 100)) / 25);
  return clamp(threshold, SERVER_CONFIDENCE_FLOOR, 0.95);
}

export function detectInBrowser(features: Features, settings: Settings): Detection {
  const { fps } = features;
  const onsets = perInstrument<Onset[]>(() => []);
  for (const inst of BAND_INSTRUMENTS) {
    onsets[inst] = pickPeaks(features.odf[inst], fps, sensitivityToDelta(settings.sensitivity[inst]));
  }
  const period = settings.bpm ? (60 * fps) / settings.bpm : estimatePeriod(features.combined, fps);
  const beatTimes = trackBeats(features.combined, period).map((frame) => frame / fps);
  return { onsets, beatTimes, suppressBleed: true };
}

export function detectionFromServer(result: ServerHits, settings: Settings): Detection {
  const onsets = perInstrument((inst) => {
    const min = sensitivityToConfidence(inst, settings.sensitivity[inst]);
    return (result.hits[inst] ?? []).filter(([, c]) => c >= min).map(([time, strength]) => ({ time, strength }));
  });
  let beatTimes = result.beats;
  let downbeatTimes = result.downbeats;
  if (settings.beatScale === 2) {
    beatTimes = beatTimes.flatMap((b, i) => (i + 1 < beatTimes.length ? [b, (b + beatTimes[i + 1]) / 2] : [b]));
  } else if (settings.beatScale === 0.5) {
    // Keep the beats that land on downbeats, so bars still start in the right place.
    const firstDown = downbeatTimes.length ? nearestIndex(beatTimes, downbeatTimes[0]) : 0;
    beatTimes = beatTimes.filter((_, i) => mod(i - firstDown, 2) === 0);
    downbeatTimes = downbeatTimes.filter((_, i) => i % 2 === 0);
  }
  return { onsets, beatTimes, downbeatTimes, suppressBleed: false };
}

/** Puts detected hits on a 16th-note grid, slices bars and finds the common pattern. */
export function arrange(detection: Detection, settings: Settings): Transcription {
  const { onsets, beatTimes } = detection;
  const stepTimes = subdivide(beatTimes, STEPS_PER_BEAT);

  const steps = perInstrument((inst) => quantize(onsets[inst], stepTimes));
  if (detection.suppressBleed) suppressLeakage(steps);

  const autoPhase = detection.downbeatTimes?.length
    ? phaseFromDownbeats(beatTimes, detection.downbeatTimes)
    : detectDownbeatPhase(steps, beatTimes.length);
  const phase = mod(autoPhase + settings.downbeatShift, BEATS_PER_BAR);
  const bars = sliceBars(steps, stepTimes, phase);
  const ibis = beatTimes.slice(1).map((t, i) => t - beatTimes[i]);

  return {
    bpm: ibis.length ? 60 / median(ibis) : 0,
    beatTimes,
    stepTimes,
    onsets,
    steps,
    phase,
    bars,
    consensus: consensusPattern(bars, settings.consensusThreshold),
  };
}

/** In-browser pipeline end to end. */
export function transcribe(features: Features, settings: Settings): Transcription {
  return arrange(detectInBrowser(features, settings), settings);
}

/** The bar phase most downbeats agree on (4/4 assumed; odd bars are outvoted). */
function phaseFromDownbeats(beatTimes: number[], downbeatTimes: number[]): number {
  if (beatTimes.length === 0) return 0;
  const votes = new Array(BEATS_PER_BAR).fill(0);
  for (const d of downbeatTimes) {
    const i = nearestIndex(beatTimes, d);
    if (Math.abs(beatTimes[i] - d) < 0.07) votes[mod(i, BEATS_PER_BAR)]++;
  }
  return votes.indexOf(Math.max(...votes));
}

function subdivide(beats: number[], div: number): number[] {
  if (beats.length < 2) return [];
  const out: number[] = [];
  for (let i = 0; i < beats.length; i++) {
    const ibi = i + 1 < beats.length ? beats[i + 1] - beats[i] : beats[i] - beats[i - 1];
    for (let k = 0; k < div; k++) out.push(beats[i] + (k * ibi) / div);
  }
  return out;
}

function quantize(onsets: Onset[], stepTimes: number[]): Float32Array {
  const out = new Float32Array(stepTimes.length);
  if (stepTimes.length < 2 || onsets.length === 0) return out;
  // Loudest ~10% of hits map to full velocity.
  const ref = quantile(onsets.map((o) => o.strength), 0.9) || 1;
  for (const o of onsets) {
    const i = nearestIndex(stepTimes, o.time);
    const stepDur = i + 1 < stepTimes.length ? stepTimes[i + 1] - stepTimes[i] : stepTimes[i] - stepTimes[i - 1];
    if (Math.abs(o.time - stepTimes[i]) > stepDur / 2) continue;
    out[i] = Math.max(out[i], clamp(o.strength / ref, 0.25, 1));
  }
  return out;
}

/** Neighboring bands whose drums bleed into each other (snare body into kick, snare noise into hats). */
const LEAK_PAIRS: [Instrument, Instrument][] = [
  ['kick', 'snare'],
  ['snare', 'hat'],
];
const LEAK_MAX_VELOCITY = 0.35;
const LEAK_SOURCE_MIN_VELOCITY = 0.5;

/** Drops weak hits that coincide with a strong hit in a neighboring band: most likely bleed. */
function suppressLeakage(steps: PerInstrument<Float32Array>): void {
  for (const [a, b] of LEAK_PAIRS) {
    for (let i = 0; i < steps[a].length; i++) {
      const va = steps[a][i];
      const vb = steps[b][i];
      if (va > 0 && va <= LEAK_MAX_VELOCITY && vb >= LEAK_SOURCE_MIN_VELOCITY) steps[a][i] = 0;
      else if (vb > 0 && vb <= LEAK_MAX_VELOCITY && va >= LEAK_SOURCE_MIN_VELOCITY) steps[b][i] = 0;
    }
  }
}

/**
 * Picks which of the first four beats is a downbeat, assuming 4/4.
 * 1. Backbeat decides parity: snare on 2 and 4, kick on 1 and 3.
 * 2. Between the two remaining candidates, pick the one whose "1" has clearly more kick.
 *    Otherwise take the earlier one, since songs usually start on a downbeat.
 */
function detectDownbeatPhase(steps: PerInstrument<Float32Array>, beatCount: number): number {
  const kickOn = (b: number) => steps.kick[b * STEPS_PER_BEAT];
  const snareOn = (b: number) => steps.snare[b * STEPS_PER_BEAT];

  let parityScore = 0;
  for (let b = 0; b < beatCount; b++) {
    const sign = b % 2 === 0 ? 1 : -1;
    parityScore += sign * (kickOn(b) - snareOn(b));
  }
  const first = parityScore >= 0 ? 0 : 1;
  const second = first + 2;

  let kickFirst = 0;
  let kickSecond = 0;
  for (let b = 0; b < beatCount; b++) {
    const pos = mod(b, BEATS_PER_BAR);
    if (pos === first) kickFirst += kickOn(b);
    if (pos === second) kickSecond += kickOn(b);
  }
  return kickSecond > 1.2 * kickFirst ? second : first;
}

function sliceBars(steps: PerInstrument<Float32Array>, stepTimes: number[], phase: number): Bar[] {
  const bars: Bar[] = [];
  for (let start = phase * STEPS_PER_BEAT; start + STEPS_PER_BAR <= stepTimes.length; start += STEPS_PER_BAR) {
    const pattern = emptyPattern();
    let hits = 0;
    for (const inst of INSTRUMENTS) {
      for (let k = 0; k < STEPS_PER_BAR; k++) {
        const v = steps[inst][start + k];
        pattern[inst][k] = v;
        if (v > 0) hits++;
      }
    }
    bars.push({ index: bars.length, startStep: start, startTime: stepTimes[start], pattern, hits });
  }
  return bars;
}

/** Per step, keep hits that occur in at least `threshold` of the bars that have drums. */
function consensusPattern(bars: Bar[], threshold: number): Pattern {
  const pattern = emptyPattern();
  const active = bars.filter((b) => b.hits >= 4);
  const pool = active.length ? active : bars;
  if (pool.length === 0) return pattern;
  for (const inst of INSTRUMENTS) {
    for (let k = 0; k < STEPS_PER_BAR; k++) {
      let count = 0;
      let sum = 0;
      for (const bar of pool) {
        const v = bar.pattern[inst][k];
        if (v > 0) {
          count++;
          sum += v;
        }
      }
      if (count / pool.length >= threshold) pattern[inst][k] = sum / count;
    }
  }
  return pattern;
}
