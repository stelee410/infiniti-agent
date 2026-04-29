import type { ExpressionParams } from "../templates/cartoon.js";
import type { Motion } from "../types/index.js";
import { clamp, smoothstep } from "../utils/clock.js";

// Periodic / triggered motions modulate the current ExpressionParams in place.
// They apply *after* expression easing so blinks / mouth flap aren't smoothed away.

interface BlinkState {
  next: number; // ms timestamp for next blink
  closing: boolean;
  t: number; // 0..1 progress
  dur: number;
}

interface MouthState {
  phase: number; // accumulated time
  speed: number;
  open: number;
}

interface BobState {
  t: number;
  dur: number; // 0 = no bob
  kind: "nod" | "shake" | "bounce" | null;
  speechPresence: number;
}

export class MotionEngine {
  private blink: BlinkState = {
    next: performance.now() + 1500 + Math.random() * 2000,
    closing: false,
    t: 0,
    dur: 140,
  };
  private mouth: MouthState = { phase: 0, speed: 0.012, open: 0 };
  private bob: BobState = { t: 0, dur: 0, kind: null, speechPresence: 0 };

  // Public toggles
  public speaking = false;
  public motion: Motion = "idle";

  triggerBlink(): void {
    if (!this.blink.closing) {
      this.blink.closing = true;
      this.blink.t = 0;
    }
  }

  triggerMotion(kind: Motion): void {
    this.motion = kind;
    if (kind === "idle") {
      this.bob.kind = null;
      this.bob.dur = 0;
      return;
    }
    this.bob.kind = kind;
    this.bob.t = 0;
    this.bob.dur = kind === "bounce" ? 600 : 700;
  }

  apply(params: ExpressionParams, dt: number, now: number): void {
    this.applyBlink(params, dt, now);
    this.applyMouth(params, dt);
    this.applyBob(params, dt, now);
  }

  private applyBlink(params: ExpressionParams, dt: number, now: number): void {
    const b = this.blink;
    if (!b.closing && now >= b.next) {
      b.closing = true;
      b.t = 0;
    }
    if (b.closing) {
      b.t += dt;
      const half = b.dur / 2;
      // 0..half: close, half..dur: open
      let lid: number;
      if (b.t < half) {
        lid = 1 - smoothstep(b.t / half);
      } else if (b.t < b.dur) {
        lid = smoothstep((b.t - half) / half);
      } else {
        b.closing = false;
        b.next = now + 2200 + Math.random() * 2600;
        lid = 1;
      }
      params.eyeOpen = Math.min(params.eyeOpen, lid);
    }
  }

  // When non-null, replaces the random speaking flap — the mouth-open
  // target follows this 0..1 amplitude directly. Used by audio-driven
  // playback (and later TTS) so the upper / lower lip motion tracks
  // actual loudness instead of a synthetic oscillator.
  public audioAmplitude: number | null = null;

  private applyMouth(params: ExpressionParams, dt: number): void {
    const m = this.mouth;
    if (this.audioAmplitude !== null) {
      const floor = 0.025;
      const amp = this.audioAmplitude <= floor ? 0 : (this.audioAmplitude - floor) / (1 - floor);
      const target = clamp(amp * 0.82, 0, 0.85);
      const tc = target > m.open ? 32 : 48;
      m.open += (target - m.open) * Math.min(1, dt / tc);
    } else if (this.speaking) {
      m.phase += dt;
      // Two-frequency flap so it doesn't look mechanical.
      const a = Math.sin(m.phase * 0.018) * 0.55;
      const b = Math.sin(m.phase * 0.034 + 1.3) * 0.35;
      const target = clamp(0.18 + (a + b) * 0.5 + 0.4, 0, 0.85);
      m.open += (target - m.open) * Math.min(1, dt / 50);
    } else {
      m.open += (0 - m.open) * Math.min(1, dt / 100);
    }
    params.mouthOpen = Math.max(params.mouthOpen, m.open);
  }

  private applyBob(params: ExpressionParams, dt: number, now: number): void {
    // Idle breathing — subtle vertical sway.
    params.headBobY += Math.sin(now * 0.0018) * 0.6;

    const speakingNow = this.audioAmplitude !== null ? this.mouth.open > 0.025 : this.speaking;
    const speechTarget = speakingNow ? 1 : 0;
    const speechTc = speechTarget > this.bob.speechPresence ? 120 : 260;
    this.bob.speechPresence += (speechTarget - this.bob.speechPresence) * Math.min(1, dt / speechTc);
    if (this.bob.speechPresence > 0.01) {
      const p = this.bob.speechPresence;
      params.headTilt += (
        Math.sin(now * 0.0037) * 0.0032 +
        Math.sin(now * 0.0061 + 1.7) * 0.0014
      ) * p;
      params.headBobY += (
        Math.sin(now * 0.0049 + 0.8) * 0.28 +
        this.mouth.open * 0.16
      ) * p;
    }

    if (!this.bob.kind || this.bob.dur === 0) return;
    this.bob.t += dt;
    const u = clamp(this.bob.t / this.bob.dur, 0, 1);
    const env = Math.sin(u * Math.PI);
    // Visible head motion. The deformer applies these as rigid head transform
    // (anisotropic falloff), so amplitudes can be larger without distortion.
    if (this.bob.kind === "nod") {
      params.headBobY += env * 2;
      params.headTilt += env * 0.01;
    } else if (this.bob.kind === "shake") {
      params.headTilt += Math.sin(u * Math.PI * 4) * 0.025 * env;
    } else if (this.bob.kind === "bounce") {
      params.headBobY -= env * 3;
    }
    if (u >= 1) {
      this.bob.kind = null;
      this.bob.dur = 0;
      this.motion = "idle";
    }
  }
}
