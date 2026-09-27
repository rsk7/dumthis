import type { ServerHits } from './analysis/transcribe';

/** Local analysis server (server/app.py). Override with ?server=http://host:port. */
export const SERVER_URL =
  (typeof location !== 'undefined' && new URLSearchParams(location.search).get('server')) || 'http://127.0.0.1:8765';

export interface ServerResult extends ServerHits {
  key: string;
  duration: number;
  drumsUrl: string;
  device: string;
  source: 'drums' | 'mix';
  timings: Record<string, number>;
}

interface JobView {
  id: string;
  status: 'running' | 'done' | 'error';
  stage: string;
  progress: number;
  error: string | null;
  result: ServerResult | null;
}

export const STAGE_LABELS: Record<string, string> = {
  queued: 'Waiting for the server',
  decoding: 'Decoding',
  separating: 'Separating the drums',
  beats: 'Finding beats and bars',
  transcribing: 'Detecting drum hits',
};

const POLL_MS = 500;

/** Returns the server's compute device ("mps", "cuda", "cpu"), or null if it isn't running. */
export async function checkServer(): Promise<string | null> {
  try {
    const res = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as { device: string }).device : null;
  } catch {
    return null;
  }
}

export async function analyzeOnServer(
  blob: Blob,
  fileName: string,
  onProgress: (stage: string, progress: number) => void,
): Promise<ServerResult> {
  const form = new FormData();
  form.append('file', blob, fileName);
  let job = await request<JobView>('/api/analyze', { method: 'POST', body: form });
  while (job.status === 'running') {
    onProgress(job.stage, job.progress);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    job = await request<JobView>(`/api/jobs/${job.id}`);
  }
  if (job.status === 'error' || !job.result) throw new Error(job.error ?? 'Analysis failed');
  return job.result;
}

export async function fetchDrumStem(result: ServerResult): Promise<ArrayBuffer> {
  const res = await fetch(`${SERVER_URL}${result.drumsUrl}`);
  if (!res.ok) throw new Error(`Could not download the drum track (${res.status})`);
  return res.arrayBuffer();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}${path}`, init);
  } catch {
    throw new Error(`Can't reach the local server at ${SERVER_URL}. Is it running?`);
  }
  if (!res.ok) {
    const detail = await res.json().then((b: { detail?: string }) => b.detail).catch(() => undefined);
    throw new Error(detail ?? `Server error ${res.status}`);
  }
  return res.json() as Promise<T>;
}
