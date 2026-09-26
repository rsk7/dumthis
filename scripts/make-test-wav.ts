// Writes a synthetic drum loop with a known pattern to a 16-bit mono WAV, for testing the app.
// Usage: npx vite-node scripts/make-test-wav.ts out.wav
import { writeFileSync } from 'node:fs';
import { synthLoop } from '../test/synth';
const sr = 44100;
const a = synthLoop({ bpm: 112, bars: 12, lead: 0.7, bass: true, sampleRate: sr,
  pattern: { kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] } });
const pcm = Buffer.alloc(a.length * 2);
let peak = 0; for (const v of a) peak = Math.max(peak, Math.abs(v));
a.forEach((v, i) => pcm.writeInt16LE(Math.round((v / peak) * 0.9 * 32767), i * 2));
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
writeFileSync(process.argv[2], Buffer.concat([h, pcm]));
