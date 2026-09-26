import { median } from './util';

export interface TempoOptions {
  minBpm?: number;
  maxBpm?: number;
  /** Prior favoring tempos near this value, to pick between half/double candidates. */
  preferredBpm?: number;
  /** Width of the tempo prior in octaves. */
  priorWidth?: number;
}

/** Estimates the beat period in frames (fractional) from onset-strength autocorrelation. */
export function estimatePeriod(odf: Float32Array, fps: number, opts: TempoOptions = {}): number {
  const { minBpm = 60, maxBpm = 200, preferredBpm = 120, priorWidth = 1 } = opts;
  const n = odf.length;
  const lagMin = Math.max(2, Math.floor((60 * fps) / maxBpm));
  const lagMax = Math.min(n - 2, Math.ceil((60 * fps) / minBpm));
  const preferredLag = (60 * fps) / preferredBpm;
  if (lagMax <= lagMin) return preferredLag;

  let mean = 0;
  for (const v of odf) mean += v;
  mean /= n;

  const score = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += (odf[i] - mean) * (odf[i + lag] - mean);
    const prior = Math.exp(-0.5 * (Math.log2(lag / preferredLag) / priorWidth) ** 2);
    score[lag] = (sum / (n - lag)) * prior;
  }

  let best = lagMin;
  for (let lag = lagMin; lag <= lagMax; lag++) if (score[lag] > score[best]) best = lag;

  // Parabolic interpolation for a sub-frame period estimate.
  const [a, b, c] = [score[best - 1], score[best], score[best + 1]];
  const denom = a - 2 * b + c;
  const offset = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return best + Math.max(-0.5, Math.min(0.5, offset));
}

/**
 * Dynamic-programming beat tracker (Ellis 2007, as in librosa). Finds the beat sequence
 * that best lines up with onset strength while keeping inter-beat intervals near `period`.
 * Beats can drift, so songs without a click track still get a usable grid.
 * Returns beat positions in frames.
 */
export function trackBeats(odf: Float32Array, period: number, tightness = 100): number[] {
  const n = odf.length;
  if (n === 0 || period <= 0) return [];

  // Light Gaussian smoothing so the tracker tolerates small timing jitter.
  const half = Math.max(1, Math.ceil(period / 8));
  const win = new Float64Array(2 * half + 1);
  for (let k = -half; k <= half; k++) win[k + half] = Math.exp(-0.5 * ((k * 32) / period) ** 2);
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const i = t + k;
      if (i >= 0 && i < n) s += odf[i] * win[k + half];
    }
    local[t] = s;
  }

  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.round(2 * period);
  const txCost = new Float64Array(hi - lo + 1);
  for (let d = lo; d <= hi; d++) txCost[d - lo] = -tightness * Math.log(d / period) ** 2;

  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const v = cum[t - d] + txCost[d - lo];
      if (v > best) {
        best = v;
        arg = t - d;
      }
    }
    cum[t] = local[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }

  // Last beat: the final local maximum of the cumulative score that is not unusually weak.
  const maxima: number[] = [];
  for (let t = 1; t < n - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) maxima.push(t);
  if (maxima.length === 0) return [];
  const threshold = 0.5 * median(maxima.map((t) => cum[t]));
  let last = maxima[maxima.length - 1];
  for (let i = maxima.length - 1; i >= 0; i--) {
    if (cum[maxima[i]] >= threshold) {
      last = maxima[i];
      break;
    }
  }

  const beats: number[] = [];
  for (let t = last; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();

  // Trim weak beats at the edges (silence, fade in/out).
  const rms = Math.sqrt(beats.reduce((s, b) => s + local[b] ** 2, 0) / beats.length);
  let start = 0;
  let end = beats.length;
  while (start < end && local[beats[start]] < 0.5 * rms) start++;
  while (end > start && local[beats[end - 1]] < 0.5 * rms) end--;
  return beats.slice(start, end);
}
