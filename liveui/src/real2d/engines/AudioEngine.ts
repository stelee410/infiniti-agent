// Audio-driven mouth amplitude. Loads a File / Blob / URL via WebAudio,
// plays it through an AnalyserNode, and exposes a per-frame RMS reading
// scaled to 0..1 so the runtime can drive the phoneme overlay's
// `speakingFade` (= mouth-open amplitude) from real audio.
//
// Phase-1 surface only — pure amplitude drive. Phase-2 (TTS visemes /
// formant-based phoneme selection) layers on top of this without
// changing the API: callers can always sample `getAmplitude()`, and we
// can later add a parallel `getPhoneme()` that returns the dominant
// vowel from formant analysis.

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private timeData = new Uint8Array(0);
  private playing = false;
  private endCb: (() => void) | null = null;

  async load(src: File | Blob | string): Promise<void> {
    if (!this.ctx) this.ctx = new AudioContext();
    let ab: ArrayBuffer;
    if (src instanceof Blob) {
      ab = await src.arrayBuffer();
    } else {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`audio fetch failed: ${res.status}`);
      ab = await res.arrayBuffer();
    }
    this.buffer = await this.ctx.decodeAudioData(ab);
  }

  async play(): Promise<void> {
    if (!this.ctx || !this.buffer) throw new Error("audio not loaded");
    if (this.ctx.state === "suspended") await this.ctx.resume();

    this.stop();

    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      // Short window — we want responsive amplitude, not spectral detail.
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.4;
      this.timeData = new Uint8Array(this.analyser.fftSize);
      this.analyser.connect(this.ctx.destination);
    }

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.analyser);
    src.onended = () => {
      if (this.source !== src) return;
      this.playing = false;
      this.source = null;
      this.endCb?.();
    };
    src.start();
    this.source = src;
    this.playing = true;
  }

  stop(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
  }

  // 0..1 amplitude. RMS over the latest analyser window, with a fixed
  // gain so a typical speaking voice peaks near ~1 instead of ~0.25.
  getAmplitude(): number {
    if (!this.analyser || !this.playing) return 0;
    this.analyser.getByteTimeDomainData(this.timeData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.timeData.length);
    return Math.min(1, rms * 4);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  onEnded(cb: () => void): void {
    this.endCb = cb;
  }

  destroy(): void {
    this.stop();
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
