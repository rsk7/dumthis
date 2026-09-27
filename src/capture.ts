interface UADataLike {
  brands: { brand: string }[];
  mobile: boolean;
}

/**
 * Records the audio of another browser tab (e.g. a YouTube video) via screen sharing.
 * Tab audio sharing is supported in Chromium browsers on desktop only. Safari and Firefox
 * implement getDisplayMedia but only offer screens/windows, with no audio.
 */
export class TabCapture {
  /** Fires if the user ends sharing from the browser's own "Stop sharing" bar. */
  onEnded: (() => void) | null = null;

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  static isSupported(): boolean {
    // userAgentData only exists in Chromium browsers (Chrome, Edge, Arc, Brave, Opera).
    const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
    const desktopChromium = !!uaData && !uaData.mobile && uaData.brands.some((b) => b.brand === 'Chromium');
    return (
      desktopChromium &&
      typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  get elapsed(): number {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** Asks the user to pick a tab and starts recording its audio. */
  async start(): Promise<void> {
    const options = {
      // Chrome requires video to be requested to offer tab audio; the video is never used.
      // Open Chrome's picker on the tab list rather than screens.
      video: { displaySurface: 'browser' },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'include',
    } as DisplayMediaStreamOptions;
    const stream = await navigator.mediaDevices.getDisplayMedia(options);

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(
        surface && surface !== 'browser'
          ? 'You shared a window or screen, which can’t include audio. Try again and pick a tab from the “Chrome Tab” list.'
          : 'No audio was shared. Try again and turn on “Also share tab audio” before clicking Share.',
      );
    }

    this.stream = stream;
    this.chunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    this.recorder = new MediaRecorder(new MediaStream(audioTracks), {
      ...(mimeType && { mimeType }),
      audioBitsPerSecond: 256_000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    audioTracks[0].addEventListener('ended', () => this.onEnded?.());
    this.recorder.start(1000);
    this.startedAt = performance.now();
  }

  /** Stops recording and returns the encoded audio. */
  async stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('Not recording.');
    if (recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.stop();
      });
    }
    const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
    this.release();
    return blob;
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
