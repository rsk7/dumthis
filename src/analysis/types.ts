export const INSTRUMENTS = ['kick', 'snare', 'hat'] as const;
export type Instrument = (typeof INSTRUMENTS)[number];
export type PerInstrument<T> = Record<Instrument, T>;

export const STEPS_PER_BEAT = 4;
export const BEATS_PER_BAR = 4;
export const STEPS_PER_BAR = STEPS_PER_BEAT * BEATS_PER_BAR;

/** One bar of 16th-note steps per instrument. Values are velocities in 0..1; 0 means no hit. */
export type Pattern = PerInstrument<number[]>;

export function emptyPattern(): Pattern {
  return {
    kick: new Array(STEPS_PER_BAR).fill(0),
    snare: new Array(STEPS_PER_BAR).fill(0),
    hat: new Array(STEPS_PER_BAR).fill(0),
  };
}

export function clonePattern(p: Pattern): Pattern {
  return { kick: [...p.kick], snare: [...p.snare], hat: [...p.hat] };
}
