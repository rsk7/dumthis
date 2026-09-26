import * as Tone from 'tone';
import type { Transcription } from './analysis/transcribe';
import { INSTRUMENTS, STEPS_PER_BAR, type Pattern } from './analysis/types';
import type { Voice } from './kit';

export type PlayMode = 'stopped' | 'song' | 'loop';

/** Synth drum kit plus song playback, both driven by the Tone.js transport. */
export class Engine {
  mode: PlayMode = 'stopped';
  onStop: (() => void) | null = null;

  private readonly drums = new Tone.Gain(0.8).toDestination();
  private readonly songGain = new Tone.Gain(0.7).toDestination();
  private readonly kick = new Tone.MembraneSynth({
    pitchDecay: 0.04,
    octaves: 6,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.05 },
  }).connect(this.drums);
  private readonly snareBody = new Tone.MembraneSynth({
    pitchDecay: 0.01,
    octaves: 2,
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.02 },
  }).connect(this.drums);
  private readonly snareNoise = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.16, sustain: 0 },
  });
  private readonly hat = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.06, release: 0.01 },
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5,
    volume: -14,
  });
  private readonly openHat = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.45, release: 0.05 },
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5,
    volume: -16,
  });
  private readonly clap = new Tone.NoiseSynth({
    noise: { type: 'pink' },
    envelope: { attack: 0.004, decay: 0.14, sustain: 0 },
    volume: -2,
  });
  private readonly tomLow = new Tone.MembraneSynth({
    pitchDecay: 0.03,
    octaves: 3,
    envelope: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.05 },
  }).connect(this.drums);
  private readonly tomHigh = new Tone.MembraneSynth({
    pitchDecay: 0.03,
    octaves: 3,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.05 },
  }).connect(this.drums);
  private readonly crash = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 1.4, release: 0.3 },
    harmonicity: 5.1,
    modulationIndex: 40,
    resonance: 5000,
    octaves: 1.5,
    volume: -20,
  });
  /** 808-style sub bass: a slow membrane with a little pitch drop. */
  private readonly bass = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 1.2,
    envelope: { attack: 0.002, decay: 1.1, sustain: 0.2, release: 0.3 },
    volume: -2,
  }).connect(this.drums);
  private readonly metronome = new Tone.Synth({
    oscillator: { type: 'square' },
    envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.01 },
    volume: -20,
  }).toDestination();
  private player: Tone.Player | null = null;
  private sequence: Tone.Sequence<number> | null = null;
  private songOffset = 0;

  constructor() {
    this.snareNoise.chain(new Tone.Filter(1800, 'highpass'), this.drums);
    this.hat.chain(new Tone.Filter(7000, 'highpass'), this.drums);
    this.openHat.chain(new Tone.Filter(6000, 'highpass'), this.drums);
    this.clap.chain(new Tone.Filter({ frequency: 1200, type: 'bandpass', Q: 1.2 }), this.drums);
    this.crash.chain(new Tone.Filter(5000, 'highpass'), this.drums);
  }

  loadSong(buffer: AudioBuffer): void {
    this.stop();
    this.player?.dispose();
    this.player = new Tone.Player(buffer).connect(this.songGain);
  }

  setSongVolume(v: number): void {
    this.songGain.gain.rampTo(v, 0.05);
  }

  setDrumVolume(v: number): void {
    this.drums.gain.rampTo(v, 0.05);
  }

  setBpm(bpm: number): void {
    Tone.getTransport().bpm.value = bpm;
  }

  /** Current position in the song, in seconds, while playing along with it. */
  songTime(): number | null {
    return this.mode === 'song' ? Math.max(0, Tone.getTransport().seconds) + this.songOffset : null;
  }

  /** Plays the song with the full transcription layered on top, starting at `from` seconds. */
  async playSong(tx: Transcription, from: number): Promise<void> {
    if (!this.player) return;
    await Tone.start();
    this.stop();
    const transport = Tone.getTransport();

    this.player.sync().start(0, from);
    tx.stepTimes.forEach((t, step) => {
      if (t < from - 0.001) return;
      for (const inst of INSTRUMENTS) {
        const v = tx.steps[inst][step];
        if (v > 0) transport.schedule((time) => this.hit(inst, v, time), t - from);
      }
    });
    transport.scheduleOnce((time) => Tone.getDraw().schedule(() => this.stop(), time), this.player.buffer.duration - from);

    this.songOffset = from;
    this.mode = 'song';
    transport.start('+0.05');
  }

  /** Loops one bar. `getPattern` is read on every step, so edits apply immediately. */
  async playLoop(getPattern: () => Pattern, bpm: number, onStep: (step: number) => void): Promise<void> {
    await Tone.start();
    this.stop();
    this.setBpm(bpm);
    const steps = Array.from({ length: STEPS_PER_BAR }, (_, i) => i);
    this.sequence = new Tone.Sequence<number>(
      (time, step) => {
        const pattern = getPattern();
        for (const inst of INSTRUMENTS) {
          const v = pattern[inst][step];
          if (v > 0) this.hit(inst, v, time);
        }
        Tone.getDraw().schedule(() => onStep(step), time);
      },
      steps,
      '16n',
    ).start(0);
    this.mode = 'loop';
    Tone.getTransport().start('+0.05');
  }

  stop(): void {
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel();
    this.player?.unsync();
    this.sequence?.dispose();
    this.sequence = null;
    const wasPlaying = this.mode !== 'stopped';
    this.mode = 'stopped';
    if (wasPlaying) this.onStop?.();
  }

  /** Plays one sound. `note` only applies to the bass. */
  hit(voice: Voice, velocity: number, time: number, note = 'C1'): void {
    try {
      switch (voice) {
        case 'kick':
          this.kick.triggerAttackRelease('C1', '8n', time, velocity);
          break;
        case 'snare':
          this.snareNoise.triggerAttackRelease('16n', time, velocity);
          this.snareBody.triggerAttackRelease('G2', '16n', time, velocity * 0.6);
          break;
        case 'hat':
          this.openHat.triggerRelease(time); // a closed hat chokes the open one
          this.hat.triggerAttackRelease(250, '32n', time, velocity);
          break;
        case 'openhat':
          this.openHat.triggerAttackRelease(250, '4n', time, velocity);
          break;
        case 'clap':
          this.clap.triggerAttackRelease('16n', time, velocity);
          break;
        case 'tomlow':
          this.tomLow.triggerAttackRelease('G1', '8n', time, velocity);
          break;
        case 'tomhigh':
          this.tomHigh.triggerAttackRelease('D2', '8n', time, velocity);
          break;
        case 'crash':
          this.crash.triggerAttackRelease(300, '1n', time, velocity);
          break;
        case 'bass':
          this.bass.triggerAttackRelease(note, '4n', time, velocity);
          break;
      }
    } catch (err) {
      // Two triggers of one monophonic voice at the exact same time throw; dropping the second is fine.
      console.warn(`Skipped ${voice} hit`, err);
    }
  }

  click(time: number, accent: boolean): void {
    this.metronome.triggerAttackRelease(accent ? 'C6' : 'G5', '32n', time, accent ? 1 : 0.6);
  }
}
