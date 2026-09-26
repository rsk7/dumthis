export interface Onset {
  time: number;
  strength: number;
}

/**
 * Peak picking after Dixon (2006): a frame is an onset if it is the local maximum,
 * exceeds the local mean by `delta`, and is far enough from the previous onset.
 */
export function pickPeaks(odf: Float32Array, fps: number, delta: number): Onset[] {
  const n = odf.length;
  const wMax = Math.max(1, Math.round(0.03 * fps));
  const wPre = Math.round(0.1 * fps);
  const wPost = Math.round(0.07 * fps);
  const minGap = Math.max(1, Math.round(0.05 * fps));

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + odf[i];

  const onsets: Onset[] = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = odf[i];
    if (v <= 0 || i - last < minGap) continue;

    let isMax = true;
    for (let j = Math.max(0, i - wMax); j <= Math.min(n - 1, i + wMax); j++) {
      if (odf[j] > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;

    const a = Math.max(0, i - wPre);
    const b = Math.min(n, i + wPost + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    if (v < mean + delta) continue;

    onsets.push({ time: i / fps, strength: v });
    last = i;
  }
  return onsets;
}
