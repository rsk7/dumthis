# Drum Machine

**Live demo: https://rsk7.github.io/dumthis/** (desktop Chrome or Edge recommended)

Two tabs, both running entirely in the browser:

- **Extract from a song**: drop in a song (or record a browser tab) and get a kick / snare / hi-hat pattern you can loop and edit.
- **Play & loop**: play drum pads and bass from the keyboard and build up a loop in layers.

This is the band-split prototype: no machine learning, no stem separation.

## Run

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # analysis tests on synthetic drum loops
```

`npx vite-node scripts/make-test-wav.ts out.wav` writes a synthetic loop with a known pattern for trying the app.

Requires Node 20.x (Vite 6 / Vitest 3 are pinned for Node 20.15 compatibility).

## Recording from YouTube (or any tab)

Open the song in another tab and click **record another tab**. In Chrome's share picker, choose the **Chrome Tab** list, select the song's tab, and turn on **Also share tab audio**. Then play the song and click **Stop & analyze**. Clicking the browser's own "Stop sharing" button also stops and analyzes. 30–60 seconds of steady drums is enough.

This uses `getDisplayMedia` + `MediaRecorder`, so it only works in desktop Chromium browsers (Chrome, Edge, Arc, Brave). Safari and Firefox only offer to share a screen or window, with no audio, so the page shows a note there instead. Picking a window or screen in Chrome also gives no audio. Recording happens in real time, and anything else the tab plays (such as ads) ends up in the recording.

## Play & loop

| Keys | Sound |
| --- | --- |
| `A S D F G H J K` | kick, snare, closed hat, open hat, clap, low tom, high tom, crash |
| `Z X C V B N M ,` | 808-style bass, C minor pentatonic from C1 to F2 |
| `R` | record on/off (starts the loop, with a count-in if enabled) |
| `Space` | play / stop |
| `Backspace` | undo the last recorded layer |

Keys are matched by physical position (`KeyboardEvent.code`), so they work on non-QWERTY layouts too. A closed hat cuts off a ringing open hat.

**Looper**: set the tempo, loop length (1/2/4 bars) and quantize (off, 1/8, 1/16). While recording is on, every pass keeps adding hits. Each time you press `R` to start recording, a new layer begins, and **Undo layer** removes the latest one. Loop length is locked once the loop has hits. On the Extract tab, **Open in looper** loads the current pattern as a one-bar loop at the song's tempo.

All sounds are synthesized with Tone.js (`src/engine.ts`); there are no sample files. Looper logic is in `src/looper.ts` and the pads/loop view in `src/play.ts`.

## How it works (`src/analysis/`)

1. **Band split** (`features.ts`, `dsp.ts`): mono mix → biquad filters. Kick < 110 Hz, snare 1–5 kHz, hi-hat > 7 kHz.
2. **Onset detection**: per band, the positive slope of log-compressed energy (~5.8 ms frames), then Dixon-style peak picking (`peaks.ts`). The sensitivity sliders control the peak threshold.
3. **Tempo + beats** (`tempo.ts`): autocorrelation with a tempo prior around 120 BPM, then an Ellis/librosa-style dynamic-programming beat tracker. The tracker follows tempo drift.
4. **Grid + bars** (`transcribe.ts`): each beat is split into 16ths and onsets snap to the nearest step. Weak hits that land on the same step as a strong hit in a neighboring band are dropped as bleed. The downbeat comes from the backbeat (snare on 2 and 4) and from which beat has more kick; ties go to the first beat.
5. **Consensus pattern**: a step is kept if it is hit in at least N% of the bars that contain drums.

## Known limits

- Bass guitar and synth bass land in the kick band and cause false kicks. Stem separation (Demucs) fixes this.
- The tempo can come out at half or double speed. Use the ÷2 and ×2 buttons.
- The first bar can start on the wrong beat. Use the ◀ ▶ buttons.
- Only 4/4 and 16th-note grids are handled. Triplet and swing feels get squashed onto straight 16ths.
- Toms, crashes and rides are not detected. Crashes usually show up as hi-hat.
