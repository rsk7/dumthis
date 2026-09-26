export type FilterType = 'lowpass' | 'highpass';

export interface FilterStage {
  type: FilterType;
  freq: number;
}

/** Second-order Butterworth-style filter (RBJ cookbook biquad). */
export function biquad(input: Float32Array, sampleRate: number, type: FilterType, freq: number, q = Math.SQRT1_2): Float32Array {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2;
  const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos);
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;

  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

export function filterChain(input: Float32Array, sampleRate: number, stages: FilterStage[]): Float32Array {
  return stages.reduce((signal, s) => biquad(signal, sampleRate, s.type, s.freq), input);
}

/**
 * Short-time energy, one value per hop. Frame f covers samples [(f-1)*hop, (f+1)*hop),
 * i.e. a 2-hop window centered on f*hop.
 */
export function energyEnvelope(x: Float32Array, hop: number): Float32Array {
  const blocks = Math.ceil(x.length / hop);
  const blockEnergy = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let sum = 0;
    const end = Math.min(x.length, (b + 1) * hop);
    for (let i = b * hop; i < end; i++) sum += x[i] * x[i];
    blockEnergy[b] = sum;
  }
  const env = new Float32Array(blocks);
  for (let f = 0; f < blocks; f++) {
    env[f] = ((f > 0 ? blockEnergy[f - 1] : 0) + blockEnergy[f]) / (2 * hop);
  }
  return env;
}

/**
 * Onset detection function: positive slope of log-compressed energy.
 * Log compression makes quiet and loud attacks comparable.
 */
export function onsetFunction(env: Float32Array, compression = 100): Float32Array {
  let max = 0;
  for (const v of env) if (v > max) max = v;
  const odf = new Float32Array(env.length);
  if (max === 0) return odf;
  const gain = compression / max;
  let prev = Math.log1p(gain * env[0]);
  for (let i = 1; i < env.length; i++) {
    const c = Math.log1p(gain * env[i]);
    odf[i] = Math.max(0, c - prev);
    prev = c;
  }
  return odf;
}

/** Scales a signal to unit standard deviation (mean is preserved). */
export function normalizeByStd(x: Float32Array): Float32Array {
  let mean = 0;
  for (const v of x) mean += v;
  mean /= x.length || 1;
  let variance = 0;
  for (const v of x) variance += (v - mean) ** 2;
  const std = Math.sqrt(variance / (x.length || 1));
  if (std === 0) return x;
  return x.map((v) => v / std);
}
