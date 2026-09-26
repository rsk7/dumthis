import * as Tone from 'tone';
import { INSTRUMENTS, STEPS_PER_BAR, type Pattern } from './analysis/types';
import { mod } from './analysis/util';
import type { Engine } from './engine';
import type { Voice } from './kit';

export type LooperState = 'stopped' | 'countIn' | 'playing';

export interface LoopEvent {
  voice: Voice;
  note?: string;
  /** Position inside the loop, in transport ticks. Ticks are tempo-independent. */
  tick: number;
  velocity: number;
  /** Each record/overdub pass is a layer, so undo removes one pass at a time. */
  layer: number;
  /** Audio-context time the hit was recorded; used to avoid replaying a hit just heard live. */
  createdAt: number;
}

const BEATS_PER_BAR = 4;
/** A hit this long before the loop starts (during count-in) still counts, as a downbeat. */
const EARLY_HIT_BEATS = 0.25;
const LIVE_ECHO_WINDOW = 0.2;

/**
 * Loop recorder on the Tone.js transport. Each loop pass schedules every recorded event
 * for that pass, so hits recorded mid-pass are first played back on the next pass.
 */
export class Looper {
  bpm = 100;
  bars = 2;
  /** Grid division per bar (8 = eighth notes, 16 = sixteenths), or 0 for no quantizing. */
  quantize = 16;
  metronome = true;
  countIn = true;

  events: LoopEvent[] = [];
  state: LooperState = 'stopped';
  recording = false;

  onChange: (() => void) | null = null;
  onHit: ((voice: Voice, note?: string) => void) | null = null;

  private layer = 0;
  private originTicks = 0;

  constructor(private readonly engine: Engine) {}

  private get transport() {
    return Tone.getTransport();
  }

  private get ppq(): number {
    return this.transport.PPQ;
  }

  get loopTicks(): number {
    return this.bars * BEATS_PER_BAR * this.ppq;
  }

  get layerCount(): number {
    return new Set(this.events.map((e) => e.layer)).size;
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
    if (this.state !== 'stopped') this.transport.bpm.value = bpm;
  }

  /** Where the playhead is: a 0..1 fraction of the loop, or beats left in the count-in. */
  position(): { fraction: number; countInBeats: number } | null {
    if (this.state === 'stopped') return null;
    const ticks = this.transport.ticks - this.originTicks;
    if (ticks < 0) return { fraction: 0, countInBeats: Math.ceil(-ticks / this.ppq) };
    return { fraction: mod(ticks, this.loopTicks) / this.loopTicks, countInBeats: 0 };
  }

  toggleRecord(): void {
    if (this.recording) {
      this.recording = false;
    } else {
      this.layer++;
      this.recording = true;
      if (this.state === 'stopped') this.start(this.countIn);
    }
    this.changed();
  }

  togglePlay(): void {
    if (this.state === 'stopped') this.start(false);
    else this.stop();
  }

  stop(): void {
    if (this.state === 'stopped') return;
    this.transport.stop();
    this.transport.cancel();
    this.state = 'stopped';
    this.recording = false;
    this.changed();
  }

  /** Removes the most recent record/overdub pass. */
  undo(): void {
    if (this.events.length === 0) return;
    const top = Math.max(...this.events.map((e) => e.layer));
    this.events = this.events.filter((e) => e.layer !== top);
    this.changed();
  }

  clear(): void {
    this.events = [];
    this.changed();
  }

  /** Replaces the loop with a one-bar pattern, e.g. one extracted from a song. */
  loadPattern(pattern: Pattern, bpm: number): void {
    this.stop();
    this.bars = 1;
    this.bpm = Math.round(bpm);
    this.layer++;
    const ticksPerStep = (BEATS_PER_BAR * this.ppq) / STEPS_PER_BAR;
    this.events = INSTRUMENTS.flatMap((voice) =>
      pattern[voice].flatMap((velocity, step) =>
        velocity > 0 ? [{ voice, tick: step * ticksPerStep, velocity, layer: this.layer, createdAt: -Infinity }] : [],
      ),
    );
    this.changed();
  }

  /** Call right after a live hit; stores it in the loop if recording. */
  record(voice: Voice, velocity: number, note?: string): void {
    if (!this.recording || this.state === 'stopped') return;
    const now = Tone.immediate();
    let tick = this.transport.getTicksAtTime(now) - this.originTicks;
    if (tick < -EARLY_HIT_BEATS * this.ppq) return;
    if (this.quantize > 0) {
      const grid = (BEATS_PER_BAR * this.ppq) / this.quantize;
      tick = Math.round(tick / grid) * grid;
    }
    tick = mod(Math.round(tick), this.loopTicks);

    const duplicate = this.events.find(
      (e) => e.voice === voice && e.note === note && Math.abs(e.tick - tick) < this.ppq / 32,
    );
    if (duplicate) {
      duplicate.velocity = Math.max(duplicate.velocity, velocity);
      return;
    }
    this.events.push({ voice, note, tick, velocity, layer: this.layer, createdAt: now });
    this.changed();
  }

  private start(withCountIn: boolean): void {
    this.engine.stop();
    const t = this.transport;
    t.stop();
    t.cancel();
    t.bpm.value = this.bpm;
    this.originTicks = withCountIn ? BEATS_PER_BAR * this.ppq : 0;

    t.scheduleRepeat((time) => this.beat(time), '4n', 0);
    t.scheduleRepeat((time) => this.schedulePass(time), `${this.loopTicks}i`, `${this.originTicks}i`);
    if (withCountIn) {
      t.scheduleOnce((time) => {
        Tone.getDraw().schedule(() => {
          this.state = 'playing';
          this.changed();
        }, time);
      }, `${this.originTicks}i`);
    }

    this.state = withCountIn ? 'countIn' : 'playing';
    t.start('+0.05');
    this.changed();
  }

  private beat(time: number): void {
    const ticks = this.transport.getTicksAtTime(time);
    const countingIn = ticks < this.originTicks;
    if (!this.metronome && !countingIn) return;
    const beat = Math.round(ticks / this.ppq);
    this.engine.click(time, mod(beat, BEATS_PER_BAR) === 0);
  }

  private schedulePass(time: number): void {
    const passStart = Math.round(this.transport.getTicksAtTime(time));
    const secondsPerTick = 60 / (this.transport.bpm.value * this.ppq);
    for (const ev of this.events) {
      // Skip a hit recorded a moment ago that rounded into this pass: it was just heard live.
      if (time + ev.tick * secondsPerTick - ev.createdAt < LIVE_ECHO_WINDOW) continue;
      this.transport.scheduleOnce((t) => {
        if (!this.events.includes(ev)) return; // undone or cleared since scheduling
        this.engine.hit(ev.voice, ev.velocity, t, ev.note);
        Tone.getDraw().schedule(() => this.onHit?.(ev.voice, ev.note), t);
      }, `${passStart + ev.tick}i`);
    }
  }

  private changed(): void {
    this.onChange?.();
  }
}
