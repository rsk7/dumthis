import * as Tone from 'tone';
import type { Engine } from './engine';
import { BASS_KEYS, PADS, VOICE_LABELS, type Voice } from './kit';
import type { Looper } from './looper';

const LIVE_VELOCITY = 0.9;
const LANES: Voice[] = [...PADS.map((p) => p.voice), 'bass'];
const LABEL_W = 84;
const LANE_H = 18;

/** Wires up the pads, bass keys, looper controls and loop view. Returns the view's keyboard handler. */
export function setupPlayView(engine: Engine, looper: Looper): { onKeyDown: (e: KeyboardEvent) => void } {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const els = {
    pads: $('pads'),
    bassKeys: $('bassKeys'),
    bpm: $<HTMLInputElement>('loopBpm'),
    bars: $<HTMLSelectElement>('loopBars'),
    quantize: $<HTMLSelectElement>('loopQuantize'),
    metronome: $<HTMLInputElement>('metronome'),
    countIn: $<HTMLInputElement>('countIn'),
    rec: $<HTMLButtonElement>('loopRec'),
    play: $<HTMLButtonElement>('loopPlay'),
    undo: $<HTMLButtonElement>('loopUndo'),
    clear: $<HTMLButtonElement>('loopClear'),
    state: $('loopState'),
    view: $<HTMLCanvasElement>('loopView'),
  };

  // ---------- Pads ----------

  const padEls = new Map<string, HTMLElement>();
  const keyActions = new Map<string, () => void>();
  const padId = (voice: Voice, note?: string) => (note ? `bass:${note}` : voice);

  for (const pad of PADS) {
    const el = makePad(`pad ${pad.voice}`, pad.label, pad.keyLabel, () => trigger(pad.voice));
    els.pads.append(el);
    padEls.set(pad.voice, el);
    keyActions.set(pad.code, () => trigger(pad.voice));
  }
  for (const key of BASS_KEYS) {
    const el = makePad('pad bass', key.note.replace('#', '♯'), key.keyLabel, () => trigger('bass', key.note));
    els.bassKeys.append(el);
    padEls.set(padId('bass', key.note), el);
    keyActions.set(key.code, () => trigger('bass', key.note));
  }

  function makePad(className: string, label: string, keyLabel: string, onHit: () => void): HTMLButtonElement {
    const el = document.createElement('button');
    el.className = className;
    el.innerHTML = `<span class="pad-name">${label}</span><kbd>${keyLabel}</kbd>`;
    // pointerdown instead of click: sounds on press, not release.
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onHit();
    });
    return el;
  }

  function trigger(voice: Voice, note?: string): void {
    void Tone.start();
    engine.hit(voice, LIVE_VELOCITY, Tone.immediate(), note);
    looper.record(voice, LIVE_VELOCITY, note);
    flash(padId(voice, note));
  }

  function flash(id: string): void {
    const el = padEls.get(id);
    if (!el) return;
    el.classList.remove('hit');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('hit');
  }

  looper.onHit = (voice, note) => flash(padId(voice, note));

  // ---------- Looper controls ----------

  els.bpm.value = String(looper.bpm);
  els.bpm.addEventListener('change', () => {
    const v = Number(els.bpm.value);
    if (v >= 40 && v <= 240) looper.setBpm(v);
    els.bpm.value = String(looper.bpm);
  });
  els.bars.addEventListener('change', () => {
    looper.bars = Number(els.bars.value);
  });
  els.quantize.addEventListener('change', () => {
    looper.quantize = Number(els.quantize.value);
  });
  els.metronome.addEventListener('change', () => {
    looper.metronome = els.metronome.checked;
  });
  els.countIn.addEventListener('change', () => {
    looper.countIn = els.countIn.checked;
  });

  els.rec.addEventListener('click', () => {
    void Tone.start();
    looper.toggleRecord();
  });
  els.play.addEventListener('click', () => {
    void Tone.start();
    looper.togglePlay();
  });
  els.undo.addEventListener('click', () => looper.undo());
  els.clear.addEventListener('click', () => looper.clear());

  looper.onChange = render;
  render();

  function render(): void {
    const running = looper.state !== 'stopped';
    els.rec.classList.toggle('active', looper.recording);
    els.rec.innerHTML = `${looper.recording ? '● Recording' : '● Record'} <kbd>R</kbd>`;
    els.play.innerHTML = `${running ? '■ Stop' : '▶ Play'} <kbd>Space</kbd>`;
    els.undo.disabled = looper.events.length === 0;
    els.clear.disabled = looper.events.length === 0;
    // Changing the loop length would move recorded hits around, so lock it once there is something recorded.
    els.bars.disabled = running || looper.events.length > 0;
    els.bars.title = els.bars.disabled ? 'Clear the loop to change its length' : '';
    els.bars.value = String(looper.bars);
    els.bpm.value = String(looper.bpm);

    const layers = looper.layerCount;
    const summary = looper.events.length ? `${looper.events.length} hits in ${layers} layer${layers === 1 ? '' : 's'}` : 'Empty loop';
    const status =
      looper.state === 'countIn'
        ? 'Count-in…'
        : looper.recording
          ? 'Recording: every pass adds a layer until you press R again'
          : running
            ? 'Playing'
            : 'Stopped';
    els.state.textContent = `${status} · ${summary}`;
  }

  // ---------- Loop view ----------

  function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawLoop(): void {
    requestAnimationFrame(drawLoop);
    const canvas = els.view;
    if (!canvas.offsetParent) return; // view hidden

    const width = canvas.parentElement!.clientWidth;
    const height = LANE_H * LANES.length + 8;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const gridW = width - LABEL_W;
    const steps = looper.bars * 16;
    const stepW = gridW / steps;
    const rule = cssVar('--rule');
    const muted = cssVar('--muted');

    // Grid: faint 16ths, stronger beats, strongest bars.
    for (let s = 0; s <= steps; s++) {
      ctx.fillStyle = rule;
      ctx.globalAlpha = s % 16 === 0 ? 1 : s % 4 === 0 ? 0.6 : 0.2;
      ctx.fillRect(LABEL_W + s * stepW, 4, 1, height - 8);
    }
    ctx.globalAlpha = 1;

    ctx.font = `12px ${cssVar('--font')}`;
    ctx.textBaseline = 'middle';
    LANES.forEach((voice, r) => {
      const y = 4 + r * LANE_H;
      ctx.fillStyle = muted;
      ctx.fillText(VOICE_LABELS[voice], 6, y + LANE_H / 2);
      ctx.fillStyle = cssVar(`--${voice}`);
      for (const ev of looper.events) {
        if (ev.voice !== voice) continue;
        const x = LABEL_W + (ev.tick / looper.loopTicks) * gridW;
        ctx.globalAlpha = 0.4 + 0.6 * ev.velocity;
        ctx.fillRect(x + 1, y + 3, Math.max(3, stepW * 0.7), LANE_H - 6);
      }
      ctx.globalAlpha = 1;
    });

    const pos = looper.position();
    if (pos) {
      if (pos.countInBeats > 0) {
        ctx.fillStyle = cssVar('--text');
        ctx.font = `600 28px ${cssVar('--font')}`;
        ctx.textAlign = 'center';
        ctx.fillText(String(pos.countInBeats), LABEL_W + gridW / 2, height / 2);
        ctx.textAlign = 'start';
      } else {
        ctx.fillStyle = looper.recording ? cssVar('--kick') : cssVar('--accent');
        ctx.fillRect(LABEL_W + pos.fraction * gridW, 0, 2, height);
      }
    }
  }
  requestAnimationFrame(drawLoop);

  // ---------- Keyboard ----------

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const action = keyActions.get(e.code);
    if (action) {
      e.preventDefault();
      if (!e.repeat) action();
      return;
    }
    if (e.repeat) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        els.play.click();
        break;
      case 'KeyR':
        e.preventDefault();
        els.rec.click();
        break;
      case 'Backspace':
        e.preventDefault();
        looper.undo();
        break;
    }
  }

  return { onKeyDown };
}
