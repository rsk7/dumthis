export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function quantile(values: ArrayLike<number>, q: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: ArrayLike<number>): number {
  return quantile(values, 0.5);
}

/** Index of the element in ascending `sorted` closest to `x`. Assumes sorted is non-empty. */
export function nearestIndex(sorted: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - x) <= Math.abs(sorted[lo] - x)) return lo - 1;
  return lo;
}
