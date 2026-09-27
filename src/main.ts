import * as Tone from 'tone';
import './style.css';
import { computeFeatures, type Features } from './analysis/features';
import { DEFAULT_SETTINGS, transcribe, type Settings, type Transcription } from './analysis/transcribe';
import { INSTRUMENTS, STEPS_PER_BAR, clonePattern, emptyPattern, type Instrument, type Pattern } from './analysis/types';
import { nearestIndex } from './analysis/util';
import { TabCapture } from './capture';
import { Engine } from './engine';
import { Looper } from './looper';
import { setupPlayView } from './play';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  drop: $('drop'),
  file: $<HTMLInputElement>('file'),
  pick: $<HTMLButtonElement>('pick'),
  captureIntro: $('captureIntro'),
  captureUnsupported: $('captureUnsupported'),
  capture: $<HTMLButtonElement>('capture'),
  capturePanel: $('capturePanel'),
  captureTime: $('captureTime'),
  captureStop: $<HTMLButtonElement>('captureStop'),
  captureCancel: $<HTMLButtonElement>('captureCancel'),
  status: $('status'),
  results: $('results'),
  bpm: $<HTMLInputElement>('bpm'),
  bpmMode: $('bpmMode'),
  half: $<HTMLButtonElement>('half'),
  double: $<HTMLButtonElement>('double'),
  autoBpm: $<HTMLButtonElement>('autoBpm'),
  shiftLeft: $<HTMLButtonElement>('shiftLeft'),
  shiftRight: $<HTMLButtonElement>('shiftRight'),
  barStart: $('barStart'),
  barCount: $('barCount'),
  consensus: $<HTMLInputElement>('consensus'),
  consensusValue: $('consensusValue'),
  playSong: $<HTMLButtonElement>('playSong'),
  playLoop: $<HTMLButtonElement>('playLoop'),
  stop: $<HTMLButtonElement>('stop'),
  songVol: $<HTMLInputElement>('songVol'),
  drumVol: $<HTMLInputElement>('drumVol'),
  timelineWrap: $('timelineWrap'),
  timeline: $<HTMLCanvasElement>('timeline'),
  playhead: $('playhead'),
  patternSource: $('patternSource'),
  useConsensus: $<HTMLButtonElement>('useConsensus'),
  toLooper: $<HTMLButtonElement>('toLooper'),
  tabExtract: $<HTMLButtonElement>('tab-extract'),
  tabPlay: $<HTMLButtonElement>('tab-play'),
  viewExtract: $('view-extract'),
  viewPlay: $('view-play'),
  grid: $('grid'),
};

const INSTRUMENT_LABELS: Record<Instrument, string> = { kick: 'Kick', snare: 'Snare', hat: 'Hi-hat' };
const NEW_HIT_VELOCITY = 0.8;

const engine = new Engine();
const looper = new Looper(engine);
const playView = setupPlayView(engine, looper);
const settings: Settings = structuredClone(DEFAULT_SETTINGS);
let features: Features | null = null;
let tx: Transcription | null = null;
let editor: Pattern = emptyPattern();
let selectedBar: number | null = null;
let timelineCell = 4;

// ---------- Loading ----------

els.pick.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  const file = els.file.files?.[0];
  if (file) void loadFile(file);
});
els.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.drop.classList.add('over');
});
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('over');
  const file = e.dataTransfer?.files[0];
  if (file) void loadFile(file);
});

async function loadFile(file: File): Promise<void> {
  await loadAudio(file.name, file);
}

/** Decodes any audio blob the browser understands and runs the analysis on it. */
async function loadAudio(name: string, blob: Blob): Promise<void> {
  engine.stop();
  setStatus(`Decoding ${name}…`);
  try {
    const buffer = await Tone.getContext().decodeAudioData(await blob.arrayBuffer());
    const mono = toMono(buffer);
    if (peak(mono) < 1e-4) {
      setStatus(`${name} is silent. If you recorded a tab, make sure it was playing and “Also share tab audio” was on.`);
      return;
    }
    setStatus('Analyzing…');
    await nextFrame();
    const t0 = performance.now();
    features = computeFeatures(mono, buffer.sampleRate);
    engine.loadSong(buffer);
    settings.bpm = null;
    settings.downbeatShift = 0;
    selectedBar = null;
    retranscribe();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`${name} · ${formatTime(buffer.duration)} · analyzed in ${secs}s`);
    els.results.hidden = false;
  } catch (err) {
    setStatus(`Could not read ${name}: ${errorMessage(err)}`);
  }
}

function peak(x: Float32Array): number {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  return max;
}

// ---------- Tab capture ----------

const MIN_CAPTURE_SECONDS = 5;
const capture = new TabCapture();
let captureTimer = 0;

if (!TabCapture.isSupported()) {
  els.captureIntro.hidden = true;
  els.captureUnsupported.hidden = false;
}

els.capture.addEventListener('click', () => void startCapture());
els.captureStop.addEventListener('click', () => void finishCapture());
els.captureCancel.addEventListener('click', () => {
  capture.cancel();
  showCapturePanel(false);
  setStatus('Recording cancelled.');
});
capture.onEnded = () => void finishCapture();

async function startCapture(): Promise<void> {
  engine.stop();
  setStatus('In the picker: choose “Chrome Tab”, select the song’s tab, and turn on “Also share tab audio”.');
  try {
    await capture.start();
  } catch (err) {
    // NotAllowedError means the user closed the picker; nothing to report.
    const cancelled = err instanceof DOMException && err.name === 'NotAllowedError';
    setStatus(cancelled ? '' : errorMessage(err));
    return;
  }
  showCapturePanel(true);
  setStatus('Recording… Play the song in the shared tab.');
}

async function finishCapture(): Promise<void> {
  if (!capture.recording) return;
  const seconds = capture.elapsed;
  const blob = await capture.stop();
  showCapturePanel(false);
  if (seconds < MIN_CAPTURE_SECONDS) {
    setStatus(`Only ${seconds.toFixed(1)}s recorded. Record at least ${MIN_CAPTURE_SECONDS}s so the tempo can be found.`);
    return;
  }
  await loadAudio('Tab recording', blob);
}

function showCapturePanel(show: boolean): void {
  els.capturePanel.hidden = !show;
  els.captureIntro.hidden = show || !TabCapture.isSupported();
  els.pick.disabled = show;
  clearInterval(captureTimer);
  if (show) {
    els.captureTime.textContent = '0:00';
    captureTimer = window.setInterval(() => (els.captureTime.textContent = formatTime(capture.elapsed)), 250);
  }
}

function toMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

// ---------- Analysis ----------

function retranscribe(): void {
  if (!features) return;
  if (engine.mode === 'song') engine.stop();
  tx = transcribe(features, settings);
  if (selectedBar !== null && selectedBar >= tx.bars.length) selectedBar = null;
  loadEditor();
  if (engine.mode === 'loop') engine.setBpm(tx.bpm);
  renderInfo();
  renderTimeline();
}

let debounceTimer = 0;
function retranscribeSoon(): void {
  clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(retranscribe, 120);
}

function loadEditor(): void {
  if (!tx) return;
  editor = clonePattern(selectedBar === null ? tx.consensus : tx.bars[selectedBar].pattern);
  els.patternSource.textContent = selectedBar === null ? '· consensus of all bars' : `· bar ${selectedBar + 1}`;
  els.useConsensus.hidden = selectedBar === null;
  renderGrid();
}

// ---------- Controls ----------

for (const inst of INSTRUMENTS) {
  const input = $<HTMLInputElement>(`sens-${inst}`);
  input.value = String(settings.sensitivity[inst]);
  input.addEventListener('input', () => {
    settings.sensitivity[inst] = Number(input.value);
    retranscribeSoon();
  });
}

els.consensus.value = String(settings.consensusThreshold * 100);
els.consensus.addEventListener('input', () => {
  settings.consensusThreshold = Number(els.consensus.value) / 100;
  retranscribeSoon();
});

els.bpm.addEventListener('change', () => {
  const v = Number(els.bpm.value);
  if (v >= 40 && v <= 240) {
    settings.bpm = v;
    retranscribe();
  }
});
els.half.addEventListener('click', () => setBpm(tx && tx.bpm / 2));
els.double.addEventListener('click', () => setBpm(tx && tx.bpm * 2));
els.autoBpm.addEventListener('click', () => {
  settings.bpm = null;
  retranscribe();
});

function setBpm(bpm: number | null): void {
  if (!bpm) return;
  settings.bpm = Math.min(240, Math.max(40, bpm));
  retranscribe();
}

els.shiftLeft.addEventListener('click', () => shiftBars(-1));
els.shiftRight.addEventListener('click', () => shiftBars(1));

function shiftBars(delta: number): void {
  settings.downbeatShift += delta;
  retranscribe();
}

els.playSong.addEventListener('click', () => {
  if (!tx) return;
  looper.stop();
  const from = selectedBar === null ? 0 : tx.bars[selectedBar].startTime;
  void engine.playSong(tx, from).then(renderTransport);
});
els.playLoop.addEventListener('click', () => {
  if (!tx) return;
  looper.stop();
  void engine.playLoop(() => editor, tx.bpm, highlightStep).then(renderTransport);
});
els.stop.addEventListener('click', () => engine.stop());
engine.onStop = () => {
  highlightStep(-1);
  renderTransport();
};

els.songVol.addEventListener('input', () => engine.setSongVolume(Number(els.songVol.value) / 100));
els.drumVol.addEventListener('input', () => engine.setDrumVolume(Number(els.drumVol.value) / 100));

els.useConsensus.addEventListener('click', () => selectBar(null));
els.toLooper.addEventListener('click', () => {
  if (!tx) return;
  looper.loadPattern(editor, tx.bpm);
  showView('play');
});

els.timeline.addEventListener('click', (e) => {
  if (!tx) return;
  const bar = Math.floor(e.offsetX / (timelineCell * STEPS_PER_BAR));
  if (bar >= 0 && bar < tx.bars.length) selectBar(bar === selectedBar ? null : bar);
});

function selectBar(bar: number | null): void {
  selectedBar = bar;
  loadEditor();
  renderTimeline();
}

// ---------- Tabs & keyboard ----------

type View = 'extract' | 'play';
let activeView: View = 'extract';

els.tabExtract.addEventListener('click', () => showView('extract'));
els.tabPlay.addEventListener('click', () => showView('play'));

function showView(view: View): void {
  if (view === activeView) return;
  engine.stop();
  looper.stop();
  activeView = view;
  els.viewExtract.hidden = view !== 'extract';
  els.viewPlay.hidden = view !== 'play';
  els.tabExtract.setAttribute('aria-selected', String(view === 'extract'));
  els.tabPlay.setAttribute('aria-selected', String(view === 'play'));
}

function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'range', 'button'].includes(target.type);
}

document.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return;
  // A focused button would also react to Space/Enter natively; drop focus so keys only do one thing.
  if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
  if (activeView === 'play') {
    playView.onKeyDown(e);
    return;
  }
  if (e.code !== 'Space' || !tx) return;
  e.preventDefault();
  if (engine.mode === 'stopped') els.playLoop.click();
  else engine.stop();
});

// ---------- Rendering ----------

function renderInfo(): void {
  if (!tx) return;
  if (document.activeElement !== els.bpm) els.bpm.value = tx.bpm.toFixed(1);
  els.bpmMode.textContent = settings.bpm === null ? 'estimated from the audio' : 'set by you';
  const first = tx.bars[0];
  els.barStart.textContent = first ? formatTime(first.startTime, true) : '—';
  els.barCount.textContent = `${tx.bars.length} bars, ${tx.beatTimes.length} beats`;
  els.consensusValue.textContent = `step must hit in ≥ ${Math.round(settings.consensusThreshold * 100)}% of bars`;
}

function renderTransport(): void {
  els.playSong.classList.toggle('active', engine.mode === 'song');
  els.playLoop.classList.toggle('active', engine.mode === 'loop');
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const ROW_H = 14;
const HEAD_H = 16;
const MAX_CANVAS_PX = 16000;

function renderTimeline(): void {
  if (!tx) return;
  const canvas = els.timeline;
  const stepCount = tx.bars.length * STEPS_PER_BAR;
  timelineCell = stepCount * 4 > MAX_CANVAS_PX ? MAX_CANVAS_PX / stepCount : 4;
  const width = Math.max(1, Math.ceil(stepCount * timelineCell));
  const height = HEAD_H + ROW_H * INSTRUMENTS.length;
  const dpr = Math.min(window.devicePixelRatio || 1, 32000 / width);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const barW = timelineCell * STEPS_PER_BAR;
  const colors = Object.fromEntries(INSTRUMENTS.map((i) => [i, cssVar(`--${i}`)])) as Record<Instrument, string>;
  ctx.font = `10px ${cssVar('--font-mono')}`;

  tx.bars.forEach((bar, b) => {
    const x = b * barW;
    ctx.fillStyle = b === selectedBar ? cssVar('--selected') : b % 2 ? cssVar('--stripe') : 'transparent';
    ctx.fillRect(x, 0, barW, height);
    ctx.fillStyle = cssVar('--rule');
    ctx.fillRect(x, 0, 1, height);
    if (b % 4 === 0 || b === selectedBar) {
      ctx.fillStyle = cssVar('--muted');
      ctx.fillText(String(b + 1), x + 3, 11);
    }
    INSTRUMENTS.forEach((inst, r) => {
      ctx.fillStyle = colors[inst];
      bar.pattern[inst].forEach((v, k) => {
        if (v <= 0) return;
        ctx.globalAlpha = 0.35 + 0.65 * v;
        ctx.fillRect(x + k * timelineCell, HEAD_H + r * ROW_H + 2, Math.max(1, timelineCell - 1), ROW_H - 4);
      });
      ctx.globalAlpha = 1;
    });
  });
}

function renderGrid(): void {
  const frag = document.createDocumentFragment();
  for (const inst of INSTRUMENTS) {
    const label = document.createElement('div');
    label.className = 'row-label';
    label.innerHTML = `<span class="dot ${inst}"></span>${INSTRUMENT_LABELS[inst]}`;
    frag.append(label);
    editor[inst].forEach((v, step) => {
      const cell = document.createElement('button');
      cell.className = `cell ${inst}${step % 4 === 0 ? ' beat' : ''}`;
      cell.dataset.step = String(step);
      cell.dataset.on = String(v > 0);
      cell.style.setProperty('--v', String(v));
      cell.setAttribute('aria-label', `${INSTRUMENT_LABELS[inst]} step ${step + 1}`);
      cell.setAttribute('aria-pressed', String(v > 0));
      cell.addEventListener('click', () => {
        editor[inst][step] = editor[inst][step] > 0 ? 0 : NEW_HIT_VELOCITY;
        renderGrid();
      });
      frag.append(cell);
    });
  }
  els.grid.replaceChildren(frag);
}

function highlightStep(step: number): void {
  els.grid.querySelectorAll<HTMLElement>('.cell').forEach((c) => {
    c.classList.toggle('current', Number(c.dataset.step) === step);
  });
}

/** Moves the playhead along the timeline while the song plays. */
function tick(): void {
  const t = engine.songTime();
  if (t !== null && tx && tx.bars.length) {
    const x = (timeToStep(tx.stepTimes, t) - tx.bars[0].startStep) * timelineCell;
    els.playhead.hidden = false;
    els.playhead.style.transform = `translateX(${x}px)`;
    const wrap = els.timelineWrap;
    if (x < wrap.scrollLeft || x > wrap.scrollLeft + wrap.clientWidth - 40) wrap.scrollLeft = x - 40;
  } else {
    els.playhead.hidden = true;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function timeToStep(stepTimes: number[], t: number): number {
  const i = nearestIndex(stepTimes, t);
  const j = stepTimes[i] <= t ? i : i - 1;
  if (j < 0) return 0;
  if (j + 1 >= stepTimes.length) return j;
  return j + (t - stepTimes[j]) / (stepTimes[j + 1] - stepTimes[j]);
}

// ---------- Helpers ----------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function setStatus(text: string): void {
  els.status.textContent = text;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
}

function formatTime(seconds: number, precise = false): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${precise ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0')}`;
}
