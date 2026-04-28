import { AudioEngine } from "../engines/AudioEngine.js";
import { EffectEngine } from "../engines/EffectEngine.js";
import {
  easeParams,
  targetFromState,
} from "../engines/ExpressionEngine.js";
import { CartoonRenderer } from "../engines/CartoonRenderer.js";
import { PhotoRenderer } from "../engines/PhotoRenderer.js";
import {
  SpriteRenderer,
  SPRITE_KEYS,
  PHONEME_KEYS,
  TALK_KEY,
  type SpriteKey,
  type SpriteSet,
  type PhonemeKey,
  type PhonemeSet,
  type TalkKey,
} from "../engines/SpriteRenderer.js";
export type { PhonemeKey, TalkKey } from "../engines/SpriteRenderer.js";
export { TALK_KEY } from "../engines/SpriteRenderer.js";
import type { Renderer } from "../engines/Renderer.js";
import { IdentityEngine, type IdentityProfile } from "../identity/IdentityEngine.js";
import { MotionEngine } from "../engines/MotionEngine.js";
import { PropEngine } from "../engines/PropEngine.js";
import { SceneEngine } from "../engines/SceneEngine.js";
import { UILayer } from "../engines/UILayer.js";
import { buildLayers, teardownLayers, type LayerSet } from "../layers/LayerManager.js";
import { baseExpression, type ExpressionParams } from "../templates/cartoon.js";
import type {
  AvatarRuntimeConfig,
  AvatarState,
  RuntimeError,
  SceneBackground,
  SceneMood,
  WsMessage,
} from "../types/index.js";
import { FrameClock } from "../utils/clock.js";
import { WsClient } from "./WsClient.js";

// Public runtime — wires every engine and exposes the SPEC §5 API.
export class AvatarRuntime {
  private layers!: LayerSet;
  private renderer!: Renderer;
  private motion!: MotionEngine;
  private scene!: SceneEngine;
  private prop!: PropEngine;
  private effect!: EffectEngine;
  private ui!: UILayer;
  private clock!: FrameClock;
  private ws: WsClient | null = null;
  private mode: "cartoon" | "photo" | "sprite" = "cartoon";
  private spriteRenderer: SpriteRenderer | null = null;
  private audio: AudioEngine | null = null;
  // Throttle audio amplitude sampling so the mouth doesn't twitch on
  // every per-frame analyser jitter. ~12 samples / sec matches roughly
  // a syllable-rate ceiling in normal speech.
  private audioSampleAccumMs = 0;
  private static readonly AUDIO_SAMPLE_INTERVAL_MS = 130;

  private current: ExpressionParams = { ...baseExpression };
  private target: ExpressionParams = { ...baseExpression };
  private state: AvatarState = { emotion: "neutral", speaking: false, gaze: "center", intensity: 1 };
  private overlay: { params: Partial<ExpressionParams>; until: number } | null = null;

  private destroyed = false;
  private readonly cfg: Required<Omit<AvatarRuntimeConfig, "photo" | "websocketUrl" | "onError">> &
    Pick<AvatarRuntimeConfig, "photo" | "websocketUrl" | "onError">;

  constructor(cfg: AvatarRuntimeConfig) {
    this.cfg = {
      container: cfg.container,
      template: cfg.template ?? "cartoon-default",
      width: cfg.width ?? 480,
      height: cfg.height ?? 480,
      autoConnect: cfg.autoConnect ?? true,
      photo: cfg.photo,
      websocketUrl: cfg.websocketUrl,
      onError: cfg.onError,
    };
  }

  init(): this {
    const root =
      typeof this.cfg.container === "string"
        ? (document.querySelector(this.cfg.container) as HTMLElement | null)
        : this.cfg.container;
    if (!root) throw new Error(`Container not found: ${String(this.cfg.container)}`);

    this.layers = buildLayers(root, this.cfg.width, this.cfg.height);
    this.renderer = new CartoonRenderer(this.layers.avatar);
    this.motion = new MotionEngine();
    this.scene = new SceneEngine(this.layers.scene);
    this.prop = new PropEngine(this.layers.prop);
    this.effect = new EffectEngine(this.layers.root, this.layers.effect);
    this.ui = new UILayer(this.layers.ui);

    this.scene.set({ background: "studio", mood: "calm" });
    this.target = targetFromState(this.state);
    this.current = { ...this.target };

    this.clock = new FrameClock((dt, now) => this.tick(dt, now));
    return this;
  }

  start(): this {
    this.clock.start();
    if (this.cfg.autoConnect && this.cfg.websocketUrl) this.connect();
    if (this.cfg.photo) {
      this.loadPhoto(this.cfg.photo).catch(() => {
        /* error already reported via onError */
      });
    }
    return this;
  }

  // SPEC §5 lifecycle
  connect(url?: string): this {
    const target = url ?? this.cfg.websocketUrl;
    if (!target) return this;
    if (!this.ws) {
      this.ws = new WsClient(
        (m) => this.handleMessage(m),
        (e, d) => this.reportError(e, d),
      );
    }
    this.ws.connect(target);
    return this;
  }

  disconnect(): this {
    this.ws?.disconnect();
    return this;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clock?.stop();
    this.ws?.disconnect();
    this.audio?.destroy();
    this.prop?.clear();
    this.ui?.clear();
    if (this.layers) teardownLayers(this.layers);
  }

  // SPEC §5 — state update
  update(state: AvatarState): this {
    this.state = { ...this.state, ...state };
    this.target = targetFromState(this.state);
    if (state.speaking !== undefined) {
      this.motion.speaking = !!state.speaking;
      this.spriteRenderer?.setSpeaking(!!state.speaking);
    }
    if (state.motion) this.motion.triggerMotion(state.motion);
    if (state.emotion && this.spriteRenderer) {
      this.spriteRenderer.setEmotion(state.emotion);
    }
    return this;
  }

  resize(width: number, height: number): this {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cfg.width = w;
    this.cfg.height = h;
    this.layers.width = w;
    this.layers.height = h;
    this.layers.dpr = dpr;
    this.layers.root.style.width = `${w}px`;
    this.layers.root.style.height = `${h}px`;
    this.layers.avatar.width = Math.round(w * dpr);
    this.layers.avatar.height = Math.round(h * dpr);
    this.layers.avatar.style.width = `${w}px`;
    this.layers.avatar.style.height = `${h}px`;
    this.layers.effect.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.layers.effect.setAttribute("width", String(w));
    this.layers.effect.setAttribute("height", String(h));
    this.renderer.resize?.(this.layers.avatar);
    return this;
  }

  setMouthOpen(value01: number): this {
    const v = Math.max(0, Math.min(1, value01));
    this.motion.audioAmplitude = v;
    this.spriteRenderer?.setAudioAmplitude(v);
    this.update({ speaking: v > 0.02 });
    return this;
  }

  // SPEC §5 — manual single render (in addition to start())
  render(): this {
    this.tick(16, performance.now());
    return this;
  }

  // Public conveniences (used by demo + WS handler)
  expression(name: AvatarState["emotion"], duration = 0): void {
    if (!name) return;
    if (duration > 0) {
      const prev = this.state.emotion;
      this.update({ emotion: name });
      window.setTimeout(() => this.update({ emotion: prev ?? "neutral" }), duration);
    } else {
      this.update({ emotion: name });
    }
  }

  setScene(bg?: SceneBackground, mood?: SceneMood): void {
    const patch: Partial<{ background: SceneBackground; mood: SceneMood }> = {};
    if (bg) patch.background = bg;
    if (mood) patch.mood = mood;
    this.scene.set(patch);
  }

  fireEffect(name: Parameters<EffectEngine["fire"]>[0], duration?: number): void {
    this.effect.fire(name, duration);
  }

  showProp(...args: Parameters<PropEngine["show"]>): string {
    return this.prop.show(...args);
  }

  say(text: string, duration?: number): void {
    this.ui.say(text, duration);
  }

  // Force a single phoneme on for `duration` ms. Used by the demo to
  // test individual visemes (a / o / ee) without the random cycle.
  sayPhoneme(key: PhonemeKey, duration = 1500): void {
    if (!this.spriteRenderer) return;
    this.spriteRenderer.setForcedPhoneme(key);
    this.update({ speaking: true });
    window.setTimeout(() => {
      this.spriteRenderer?.setForcedPhoneme(null);
      this.update({ speaking: false });
    }, duration);
  }

  // Audio-driven mouth amplitude. Loads the audio (File / Blob / URL),
  // plays it, and per-frame samples RMS to drive the base sprite's
  // mouth-open warp (and the phoneme overlay alpha when that's enabled).
  async playAudio(src: File | Blob | string): Promise<void> {
    if (!this.audio) this.audio = new AudioEngine();
    this.audio.onEnded(() => {
      this.motion.audioAmplitude = null;
      this.spriteRenderer?.clearAudioDrive();
      this.update({ speaking: false });
    });
    try {
      await this.audio.load(src);
      // Switch MotionEngine into audio-amplitude mode (replaces the
      // random speaking flap). Initial 0 so the mouth doesn't snap open.
      this.motion.audioAmplitude = 0;
      await this.audio.play();
      this.update({ speaking: true });
    } catch (e) {
      this.motion.audioAmplitude = null;
      this.reportError("RENDER_FAILED", e);
      throw e;
    }
  }

  stopAudio(): void {
    this.audio?.stop();
    this.motion.audioAmplitude = null;
    this.spriteRenderer?.clearAudioDrive();
    this.update({ speaking: false });
  }

  // SPEC §4.1 Identity Engine — load a portrait, run face landmarker once,
  // then switch the renderer to photo mode driven by the same params pipeline.
  async loadPhoto(
    src: string | File | HTMLImageElement,
    opts: { wasmPath?: string; modelPath?: string } = {},
  ): Promise<void> {
    const img = await loadImageElement(src);
    try {
      const ie = new IdentityEngine({ wasmPath: opts.wasmPath, modelPath: opts.modelPath });
      const profile = await ie.detectFromImage(img);
      this.setRendererFromProfile(profile);
    } catch (e) {
      this.reportError("LANDMARK_FAILED", e);
      throw e;
    }
  }

  setRendererFromProfile(profile: IdentityProfile): void {
    this.disposeRenderer();
    this.renderer = new PhotoRenderer(this.layers.avatar, profile);
    this.mode = "photo";
  }

  // Load 6 emotion PNGs (required) plus optional auxiliary sprites:
  //   exp_a / exp_ee / exp_o — phoneme inspection visemes (used only by
  //                            the say-* test buttons).
  //   exp_open                — single open-mouth sprite cross-faded
  //                            against the base by audio amplitude
  //                            during real speech (production lip-sync).
  async loadSpriteSet(
    files: Partial<
      Record<SpriteKey | PhonemeKey | TalkKey, File | string | HTMLImageElement>
    >,
    opts: { wasmPath?: string; modelPath?: string } = {},
  ): Promise<void> {
    const missing = SPRITE_KEYS.filter((k) => !files[k]);
    if (missing.length > 0) {
      throw new Error(`missing sprite(s): ${missing.join(", ")}`);
    }
    const ie = new IdentityEngine({ wasmPath: opts.wasmPath, modelPath: opts.modelPath });
    const set = {} as SpriteSet;
    for (const key of SPRITE_KEYS) {
      const src = files[key]!;
      const img = await loadImageElement(src);
      try {
        set[key] = await ie.detectFromImage(img);
      } catch (e) {
        this.reportError("LANDMARK_FAILED", { key, error: e });
        throw new Error(`face detection failed on ${key}: ${(e as Error).message}`);
      }
    }
    // Phoneme test sprites — optional. Skip silently on missing file or
    // landmark failure (the say-* buttons just won't have art to show).
    const phonemes: PhonemeSet = {};
    for (const key of PHONEME_KEYS) {
      const src = files[key];
      if (!src) continue;
      try {
        const img = await loadImageElement(src);
        phonemes[key] = await ie.detectFromImage(img);
      } catch (e) {
        console.warn(`[avatar] phoneme ${key} skipped:`, e);
      }
    }
    const phonemeSet = Object.values(phonemes).some((p) => p) ? phonemes : undefined;

    // Talk sprite (exp_open) — optional. If missing, speech falls back
    // to warp-only motion of the base sprite.
    let talk: IdentityProfile | undefined;
    const talkSrc = files[TALK_KEY];
    if (talkSrc) {
      try {
        const img = await loadImageElement(talkSrc);
        talk = await ie.detectFromImage(img);
      } catch (e) {
        console.warn(`[avatar] talk sprite ${TALK_KEY} skipped:`, e);
      }
    }

    this.disposeRenderer();
    const r = new SpriteRenderer(this.layers.avatar, set, phonemeSet, talk);
    r.setEmotion(this.state.emotion ?? "neutral");
    r.setSpeaking(!!this.state.speaking);
    this.renderer = r;
    this.spriteRenderer = r;
    this.mode = "sprite";
  }

  resetToCartoon(): void {
    this.disposeRenderer();
    this.renderer = new CartoonRenderer(this.layers.avatar);
    this.mode = "cartoon";
  }

  getMode(): "cartoon" | "photo" | "sprite" {
    return this.mode;
  }

  private disposeRenderer(): void {
    if (this.renderer && this.renderer.destroy) {
      try {
        this.renderer.destroy();
      } catch {
        /* ignore */
      }
    }
    this.spriteRenderer = null;
  }

  // ---------- internals ----------
  private tick(dt: number, now: number): void {
    if (this.destroyed) return;
    easeParams(this.current, this.target, dt);
    this.motion.apply(this.current, dt, now);
    this.applyOverlay(now);
    if (this.audio?.isPlaying()) {
      this.audioSampleAccumMs += dt;
      if (this.audioSampleAccumMs >= AvatarRuntime.AUDIO_SAMPLE_INTERVAL_MS) {
        const amp = this.audio.getAmplitude();
        // Drive the base sprite's mouth-open warp directly. Also keep
        // the renderer's amplitude in sync in case the phoneme overlay
        // gets toggled on mid-playback.
        this.motion.audioAmplitude = amp;
        this.spriteRenderer?.setAudioAmplitude(amp);
        this.audioSampleAccumMs = 0;
      }
    } else {
      this.audioSampleAccumMs = 0;
    }
    try {
      this.renderer.draw(this.current);
    } catch (e) {
      this.reportError("RENDER_FAILED", e);
    }
  }

  private applyOverlay(now: number): void {
    if (!this.overlay) return;
    if (now > this.overlay.until) {
      this.overlay = null;
      return;
    }
    for (const k of Object.keys(this.overlay.params) as (keyof ExpressionParams)[]) {
      const v = this.overlay.params[k];
      if (typeof v === "number") (this.current[k] as number) = v;
      else if (typeof v === "boolean") (this.current[k] as boolean) = v;
    }
  }

  private handleMessage(msg: WsMessage): void {
    switch (msg.type) {
      case "state": {
        const { type, ...rest } = msg;
        void type;
        this.update(rest);
        return;
      }
      case "expression":
        this.expression(msg.name, msg.duration ?? 0);
        return;
      case "scene":
        this.setScene(
          msg.background as SceneBackground | undefined,
          msg.mood as SceneMood | undefined,
        );
        return;
      case "effect":
        this.fireEffect(msg.name, msg.duration);
        return;
      case "prop":
        this.prop.show(msg.name, msg.position ?? "above_head", msg.duration ?? 1600);
        return;
    }
  }

  private reportError(e: RuntimeError, detail?: unknown): void {
    if (this.cfg.onError) this.cfg.onError(e, detail);
    else console.warn(`[AvatarRuntime] ${e}`, detail);
  }
}

async function loadImageElement(
  src: string | File | HTMLImageElement,
): Promise<HTMLImageElement> {
  if (src instanceof HTMLImageElement) {
    if (src.complete && src.naturalWidth > 0) return src;
    return new Promise((res, rej) => {
      src.onload = () => res(src);
      src.onerror = () => rej(new Error("image load failed"));
    });
  }
  const url = src instanceof File ? URL.createObjectURL(src) : src;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  try {
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("image load failed"));
    });
  } finally {
    if (src instanceof File) {
      // Defer revoke until after detectFromImage uses it
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  }
  return img;
}
