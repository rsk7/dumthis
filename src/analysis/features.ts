import { energyEnvelope, filterChain, normalizeByStd, onsetFunction, type FilterStage } from './dsp';
/** Instruments the band-split detector can find. */
export const BAND_INSTRUMENTS = ['kick', 'snare', 'hat'] as const;
export type BandInstrument = (typeof BAND_INSTRUMENTS)[number];
type PerBand<T> = Record<BandInstrument, T>;

/** ~5.8 ms per frame. */
const TARGET_FPS = 172;

/**
 * Frequency bands used to separate drums in the full mix. Each stage is a 12 dB/oct
 * biquad, so doubled stages give 24 dB/oct slopes.
 */
export const BAND_FILTERS: PerBand<FilterStage[]> = {
  kick: [
    { type: 'lowpass', freq: 110 },
    { type: 'lowpass', freq: 110 },
  ],
  snare: [
    { type: 'highpass', freq: 1000 },
    { type: 'highpass', freq: 1000 },
    { type: 'lowpass', freq: 5000 },
    { type: 'lowpass', freq: 5000 },
  ],
  hat: [
    { type: 'highpass', freq: 7000 },
    { type: 'highpass', freq: 7000 },
  ],
};

export interface Features {
  sampleRate: number;
  fps: number;
  duration: number;
  /** Per-band onset detection functions, unit std. */
  odf: PerBand<Float32Array>;
  /** Combined onset strength used for tempo and beat tracking, unit std. */
  combined: Float32Array;
}

export interface FeatureOptions {
  bands?: PerBand<FilterStage[]>;
  /** Log compression gain relative to the band's peak energy. */
  compression?: number;
}

export function computeFeatures(mono: Float32Array, sampleRate: number, opts: FeatureOptions = {}): Features {
  const { bands = BAND_FILTERS, compression = 100 } = opts;
  const hop = Math.round(sampleRate / TARGET_FPS);
  const fps = sampleRate / hop;
  const odf = {} as PerBand<Float32Array>;
  for (const inst of BAND_INSTRUMENTS) {
    const band = filterChain(mono, sampleRate, bands[inst]);
    odf[inst] = normalizeByStd(onsetFunction(energyEnvelope(band, hop), compression));
  }
  const combined = new Float32Array(odf.kick.length);
  for (let i = 0; i < combined.length; i++) {
    combined[i] = odf.kick[i] + odf.snare[i] + 0.5 * odf.hat[i];
  }
  return { sampleRate, fps, duration: mono.length / sampleRate, odf, combined: normalizeByStd(combined) };
}
