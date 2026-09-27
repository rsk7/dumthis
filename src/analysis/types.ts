/**
 * Everything the transcription can report. Names match the drum kit voices so hits play directly.
 * The in-browser detector only finds the first three; the local server (ADTOF) finds all five.
 */
export const INSTRUMENTS = ['kick', 'snare', 'hat', 'tomlow', 'crash'] as const;
export type Instrument = (typeof INSTRUMENTS)[number];
export type PerInstrument<T> = Record<Instrument, T>;

export const STEPS_PER_BEAT = 4;
export const BEATS_PER_BAR = 4;
export const STEPS_PER_BAR = STEPS_PER_BEAT * BEATS_PER_BAR;

/** One bar of 16th-note steps per instrument. Values are velocities in 0..1; 0 means no hit. */
export type Pattern = PerInstrument<number[]>;

export const INSTRUMENT_LABELS: PerInstrument<string> = {
  kick: 'Kick',
  snare: 'Snare',
  hat: 'Hi-hat',
  tomlow: 'Toms',
  crash: 'Cymbals',
};

export function perInstrument<T>(make: (inst: Instrument) => T): PerInstrument<T> {
  return Object.fromEntries(INSTRUMENTS.map((inst) => [inst, make(inst)])) as PerInstrument<T>;
}

export function emptyPattern(): Pattern {
  return perInstrument(() => new Array(STEPS_PER_BAR).fill(0));
}

export function clonePattern(p: Pattern): Pattern {
  return perInstrument((inst) => [...p[inst]]);
}
