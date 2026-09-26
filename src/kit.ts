export const DRUM_VOICES = ['kick', 'snare', 'hat', 'openhat', 'clap', 'tomlow', 'tomhigh', 'crash'] as const;
export type DrumVoice = (typeof DRUM_VOICES)[number];
/** Every sound the engine can play. The analysis instruments (kick, snare, hat) are a subset. */
export type Voice = DrumVoice | 'bass';

export interface PadDef {
  voice: DrumVoice;
  label: string;
  /** KeyboardEvent.code, so the physical key is the same on any keyboard layout. */
  code: string;
  keyLabel: string;
}

export const PADS: PadDef[] = [
  { voice: 'kick', label: 'Kick', code: 'KeyA', keyLabel: 'A' },
  { voice: 'snare', label: 'Snare', code: 'KeyS', keyLabel: 'S' },
  { voice: 'hat', label: 'Closed hat', code: 'KeyD', keyLabel: 'D' },
  { voice: 'openhat', label: 'Open hat', code: 'KeyF', keyLabel: 'F' },
  { voice: 'clap', label: 'Clap', code: 'KeyG', keyLabel: 'G' },
  { voice: 'tomlow', label: 'Low tom', code: 'KeyH', keyLabel: 'H' },
  { voice: 'tomhigh', label: 'High tom', code: 'KeyJ', keyLabel: 'J' },
  { voice: 'crash', label: 'Crash', code: 'KeyK', keyLabel: 'K' },
];

export interface BassKeyDef {
  note: string;
  code: string;
  keyLabel: string;
}

/** C minor pentatonic across the bottom row: easy to sound good by mashing keys. */
export const BASS_KEYS: BassKeyDef[] = [
  { note: 'C1', code: 'KeyZ', keyLabel: 'Z' },
  { note: 'D#1', code: 'KeyX', keyLabel: 'X' },
  { note: 'F1', code: 'KeyC', keyLabel: 'C' },
  { note: 'G1', code: 'KeyV', keyLabel: 'V' },
  { note: 'A#1', code: 'KeyB', keyLabel: 'B' },
  { note: 'C2', code: 'KeyN', keyLabel: 'N' },
  { note: 'D#2', code: 'KeyM', keyLabel: 'M' },
  { note: 'F2', code: 'Comma', keyLabel: ',' },
];

export const VOICE_LABELS: Record<Voice, string> = {
  ...(Object.fromEntries(PADS.map((p) => [p.voice, p.label])) as Record<DrumVoice, string>),
  bass: 'Bass',
};
