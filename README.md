# Drum Machine

**Live demo: https://rsk7.github.io/dumthis/** (desktop Chrome or Edge recommended)

Two tabs:

- **Extract from a song**: drop in a song (or record a browser tab) and get its drum pattern, which you can loop and edit.
- **Play & loop**: play drum pads and bass from the keyboard and build up a loop in layers.

Drum extraction has two engines:

- **Local server** (recommended): Demucs separates the drums, ADTOF detects kick, snare, hi-hat, toms and cymbals, and beat-this finds beats and downbeats. It runs on your machine; see [Local analysis server](#local-analysis-server).
- **In the browser**: instant with no setup, but rough. It splits the mix into frequency bands and detects kick, snare and hi-hat only.

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

## Local analysis server

Needs Python 3.12 and `ffmpeg` (`brew install ffmpeg`). About 2 GB of disk for PyTorch and the models.

```bash
npm run server:setup   # once: creates server/.venv and installs the models' dependencies
npm run server         # listens on http://127.0.0.1:8765
```

Then choose **Local server** as the analysis engine, either in `npm run dev` or on the live demo. The first run downloads the Demucs and beat-this models (about 160 MB). After that, a 3-minute song takes roughly 15–30 s on an M2 Pro (Demucs runs on the Apple GPU).

- The server only listens on `127.0.0.1` and accepts requests from `localhost` and `rsk7.github.io`. When the live demo first talks to it, Chrome may ask to allow access to devices on your local network; allow it.
- Results are cached by file hash in `server/.cache/results`, so re-opening a song is instant.
- **Play along with → Drums only** plays the separated drum track, which is handy for hearing what the model heard.
- Sensitivity sliders set a confidence threshold for each instrument; 50 is the model's default. Toms start stricter because the model over-reports them.
- ÷2 / ×2 halve or double the beat grid from the beat tracker.

### Accuracy

`npm run eval` scores detection against [MDB Drums](https://github.com/CarlSouthall/MDBDrums), real recordings with hand-labelled hits. The dataset is CC BY-NC-SA and not included; the download loop is in the header of `server/eval.py`. Results on the 15 non-jazz tracks (onset F-measure, ±50 ms):

| | kick | snare | hi-hat | toms | cymbals |
| --- | --- | --- | --- | --- | --- |
| **Server (ADTOF on the Demucs drum track)** | **0.97** | **0.92** | **0.93** | 0.43 | **0.83** |
| ADTOF on the full mix | 0.97 | 0.90 | 0.91 | 0.28 | 0.79 |
| In-browser band split | 0.50 | 0.37 | 0.79 | — | — |

Toms are the weak spot: most detected toms are false.

### Credits

- [Demucs](https://github.com/adefossez/demucs) (MIT) by Alexandre Défossez
- [beat-this](https://github.com/CPJKU/beat_this) (MIT) by CP JKU
- [ADTOF](https://github.com/MZehren/ADTOF) by Zehren et al. (CC BY-NC-SA 4.0, so **non-commercial use only**), via the [PyTorch port](https://github.com/xavriley/ADTOF-pytorch) by Xavier Riley (no license file). Both are installed as dependencies, not included in this repo. Anything commercial needs a different drum transcription model.

## How the in-browser engine works (`src/analysis/`)

1. **Band split** (`features.ts`, `dsp.ts`): mono mix → biquad filters. Kick < 110 Hz, snare 1–5 kHz, hi-hat > 7 kHz.
2. **Onset detection**: per band, the positive slope of log-compressed energy (~5.8 ms frames), then Dixon-style peak picking (`peaks.ts`). The sensitivity sliders control the peak threshold.
3. **Tempo + beats** (`tempo.ts`): autocorrelation with a tempo prior around 120 BPM, then an Ellis/librosa-style dynamic-programming beat tracker. The tracker follows tempo drift.
4. **Grid + bars** (`transcribe.ts`): each beat is split into 16ths and onsets snap to the nearest step. Weak hits that land on the same step as a strong hit in a neighboring band are dropped as bleed. The downbeat comes from the backbeat (snare on 2 and 4) and from which beat has more kick; ties go to the first beat.
5. **Consensus pattern**: a step is kept if it is hit in at least N% of the bars that contain drums.

Steps 4–5 (`arrange()` in `transcribe.ts`) are shared with the server engine. With server results, bar starts come from the model's downbeats and there is no bleed suppression.

## Known limits

- In-browser engine: bass guitar and synth bass land in the kick band and cause false kicks; guitars and vocals cause false snares. Use the server engine.
- Tempo can come out at half or double speed. Use ÷2 and ×2.
- The first bar can start on the wrong beat. Use ◀ ▶.
- Only 4/4 and 16th-note grids are handled. Triplet and swing feels get squashed onto straight 16ths.
