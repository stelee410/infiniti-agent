import { baseExpression, type ExpressionParams } from "../templates/cartoon.js";
import type { IdentityProfile } from "../identity/IdentityEngine.js";
import type { Emotion } from "../types/index.js";
import type { Renderer } from "./Renderer.js";
import { drawWarpedProfile, type FitTransform } from "./warp.js";

// SPEC §4.2 + §4.3 hybrid (Plan 3 — smart combination).
//
//   • Big expression changes (neutral → happy → angry…) are driven by
//     swapping which of 6 pre-rendered sprites is active, with a short
//     crossfade so the swap doesn't pop.
//   • Subtle "alive" motion (breathing / gaze / head tilt / mouth flap)
//     comes from the same mesh-warp pipeline that single-photo mode used,
//     applied to the *currently active sprite*. This is what restores the
//     feeling that the character is alive between expression changes.
//   • Blink is a region-only overlay: clip an ellipse around each eye on
//     the current sprite, draw the eyes_closed sprite (warped) only inside.
//     Outside the eye area, no pixels change → no whole-face flicker.
//
// Filtering: in sprite mode we deliberately drop the *emotion-driven* parts
// of ExpressionParams when computing the warp (eyeArc, mouthCurve, blush,
// brow lift…) because the active sprite already encodes those. Only the
// motion / gaze / head channels reach the warp. This avoids "double emotion"
// (sprite is smiling → warp also lifts mouth → corner overshoots).

export type SpriteKey =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "surprised"
  | "eyes_closed";

export const SPRITE_KEYS: SpriteKey[] = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "eyes_closed",
];

export type SpriteSet = Record<SpriteKey, IdentityProfile>;

// Phoneme sprites are used only by the say-a / say-o / say-ee test
// buttons to inspect individual viseme shapes — they do NOT participate
// in the production talking-overlay pipeline. Production talking uses a
// single `exp_open` sprite (see TalkProfile below) cross-faded against
// the base emotion sprite by audio amplitude. Cycling between visemes
// always read as ghost / flicker; one fixed open-mouth texture doesn't.
export type PhonemeKey = "exp_a" | "exp_ee" | "exp_o";
export const PHONEME_KEYS: PhonemeKey[] = ["exp_a", "exp_ee", "exp_o"];
export type PhonemeSet = Partial<Record<PhonemeKey, IdentityProfile>>;

// The single open-mouth sprite used during real speech. Independent of
// PhonemeKey so the two concerns stay separate (test/inspection vs.
// production lip-sync).
export const TALK_KEY = "exp_open" as const;
export type TalkKey = typeof TALK_KEY;

// Horizontal-only stretch applied to phoneme overlays on top of the
// uniform scale. 1.0 = no extra pull. Bump above 1.0 to widen vowel
// shapes a hair without scaling y.
const PHONEME_STRETCH_X = 1.0;

// Per-phoneme fit strategy.
//   "mouth": uniform scale so phoneme mouth corners land on base mouth
//            corners. Right for visemes whose source image draws a
//            wider-than-rest mouth (exp_a, exp_ee) — without this they
//            render oversized.
//   "face":  uniform scale so phoneme face matches base face size.
//            Right for visemes with naturally narrower mouths (exp_o) —
//            mouth-width matching would scale them UP and make the
//            puckered shape read as oversized.
const PHONEME_FIT_MODE: Record<PhonemeKey, "mouth" | "face"> = {
  exp_a: "mouth",
  exp_ee: "face",
  exp_o: "face",
};

export class SpriteRenderer implements Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvasW: number;
  private canvasH: number;
  private dpr: number;
  // Per-emotion-key fit transforms (face-center aligned). Phoneme fits are
  // computed dynamically per frame in draw() because they need to align to
  // whichever emotion sprite is active right now (their mouth has to land
  // exactly on that sprite's mouth, not on neutral's, to avoid drift).
  private fits: Record<string, FitTransform> = {};
  // Face height in canvas pixels (derived from neutral). Used by the
  // "face"-mode phoneme fit so visemes whose source mouths are narrower
  // than rest (exp_o, exp_ee) don't get scaled up.
  private canvasFaceSize = 0;
  private prevSprite: SpriteKey | null = null;
  private currSprite: SpriteKey = "neutral";
  private transition = 1;
  private fadeDur = 220;
  private lastNow = 0;
  // Procedural blush overlay (used for `shy` since it falls back to neutral
  // sprite). Lerps toward target each frame so it fades in/out smoothly.
  private currentEmotion: Emotion = "neutral";
  private blushAlpha = 0;
  // Lip-sync state.
  //   speakingFade — 0..1, drives the talk-sprite overlay alpha and is
  //                  also handy for any other speech-gated effects.
  //                  Lerps toward `speaking` (binary) or `audioAmplitude`
  //                  depending on whether audio is driving.
  //   talkSprite   — the single open-mouth sprite that fades in over
  //                  the base emotion sprite during speech. No cycling.
  //   phonemes     — separate test-only set used by setForcedPhoneme()
  //                  for the say-* inspection buttons.
  //   forcedPhoneme — when non-null (test mode), the talk sprite is
  //                  bypassed and the chosen viseme is rendered instead.
  private phonemes: PhonemeSet | undefined;
  private talkSprite: IdentityProfile | undefined;
  private speaking = false;
  private speakingFade = 0;
  private forcedPhoneme: PhonemeKey | null = null;
  // When true, speakingFade tracks audioAmplitude; otherwise it tracks
  // the binary `speaking` flag.
  private audioDriven = false;
  private audioAmplitude = 0;
  // Shared offscreen canvas. Each sprite is rendered here at full opacity
  // first, then blitted to the main canvas with the desired alpha. This
  // prevents the per-triangle clip inflation (0.5 px overlap) from creating
  // visible "grid lines" during crossfade — when alpha < 1, alpha
  // compounding on the overlapped regions would otherwise paint triangle
  // edges darker than their interior.
  private offscreen: HTMLCanvasElement;
  private offscreenCtx: CanvasRenderingContext2D;
  // Separate canvas for building the dual-zone phoneme mask each frame
  // (sharp alpha=1 inner core + soft blurred outer halo). Has to be
  // separate from `offscreen` so we can layer a sharp draw over a blurred
  // draw without the blur filter affecting both.
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;

  constructor(
    canvas: HTMLCanvasElement,
    private set: SpriteSet,
    phonemes?: PhonemeSet,
    talk?: IdentityProfile,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    this.canvasW = canvas.width;
    this.canvasH = canvas.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.offscreen = document.createElement("canvas");
    this.offscreen.width = this.canvasW;
    this.offscreen.height = this.canvasH;
    const oc = this.offscreen.getContext("2d");
    if (!oc) throw new Error("offscreen 2D context unavailable");
    this.offscreenCtx = oc;
    this.maskCanvas = document.createElement("canvas");
    this.maskCanvas.width = this.canvasW;
    this.maskCanvas.height = this.canvasH;
    const mc = this.maskCanvas.getContext("2d");
    if (!mc) throw new Error("mask 2D context unavailable");
    this.maskCtx = mc;
    if (phonemes && Object.values(phonemes).some((p) => p)) {
      this.phonemes = phonemes;
    }
    this.talkSprite = talk;
    this.fits = this.computeFits();
  }

  resize(canvas: HTMLCanvasElement): void {
    this.canvasW = canvas.width;
    this.canvasH = canvas.height;
    this.offscreen.width = this.canvasW;
    this.offscreen.height = this.canvasH;
    this.maskCanvas.width = this.canvasW;
    this.maskCanvas.height = this.canvasH;
    this.fits = this.computeFits();
  }

  destroy(): void {
    const closeBitmap = (p: IdentityProfile | undefined): void => {
      if (!p) return;
      try {
        p.imageBitmap.close();
      } catch {
        /* old browsers */
      }
    };
    for (const key of SPRITE_KEYS) closeBitmap(this.set[key]);
    if (this.phonemes) {
      for (const k of PHONEME_KEYS) closeBitmap(this.phonemes[k]);
    }
    closeBitmap(this.talkSprite);
  }

  setEmotion(e: Emotion): void {
    this.currentEmotion = e;
    const target = pickEmotionSprite(e);
    if (target !== this.currSprite) {
      this.prevSprite = this.currSprite;
      this.currSprite = target;
      this.transition = 0;
      this.fadeDur = 220;
    }
  }

  setSpeaking(b: boolean): void {
    this.speaking = b;
  }

  // Pin the active phoneme to a specific viseme (or pass null to release
  // back to the random cycle). Caller is responsible for setSpeaking
  // toggling around the call.
  setForcedPhoneme(key: PhonemeKey | null): void {
    if (key && this.phonemes && this.phonemes[key]) {
      this.forcedPhoneme = key;
    } else {
      this.forcedPhoneme = null;
    }
  }

  // Drive the mouth-open amplitude from an external 0..1 signal (audio
  // RMS, TTS viseme weight). While in audio-driven mode the binary
  // `speaking` lerp is bypassed.
  setAudioAmplitude(amp: number): void {
    this.audioDriven = true;
    this.audioAmplitude = Math.max(0, Math.min(1, amp));
  }

  clearAudioDrive(): void {
    this.audioDriven = false;
    this.audioAmplitude = 0;
  }

  // Replace (or clear) the open-mouth talk sprite at runtime — used
  // when the demo uploads a new exp_open texture without rebuilding
  // the renderer.
  setTalkSprite(profile: IdentityProfile | undefined): void {
    this.talkSprite = profile;
  }

  private computeFits(): Record<string, FitTransform> {
    const cssW = this.canvasW / this.dpr;
    const cssH = this.canvasH / this.dpr;
    const ref = this.set.neutral;
    const refVisible = ref.visibleBounds ?? { left: 0, top: 0, width: ref.imageW, height: ref.imageH };

    // Leave a small headroom inside the canvas. The LiveUI shell may compact
    // the transparent Electron window after measuring visible pixels; if the
    // sprite is fit flush to y=0, mid-range zooms can clip hair at the canvas
    // edge before the window-fit loop has room to recover.
    const topSafePx = Math.max(16, Math.round(cssH * 0.035));
    const fitH = Math.max(1, cssH - topSafePx);
    const refScale = Math.min(cssW / refVisible.width, fitH / refVisible.height);
    const refOX = (cssW - refVisible.width * refScale) / 2 - refVisible.left * refScale;
    const refOY = cssH - refVisible.height * refScale - refVisible.top * refScale;
    const refFC = ref.headPose.faceCenter;
    const canvasFaceX = refFC.x * refScale + refOX;
    const canvasFaceY = refFC.y * refScale + refOY;
    const refFaceSize = computeFaceSize(ref);
    const canvasFaceSize = refFaceSize * refScale;
    this.canvasFaceSize = canvasFaceSize;

    const fits: Record<string, FitTransform> = {};
    const fitFor = (p: IdentityProfile): FitTransform => {
      const sFaceSize = computeFaceSize(p);
      const scale = canvasFaceSize / sFaceSize;
      const sFC = p.headPose.faceCenter;
      return {
        scale,
        ox: canvasFaceX - sFC.x * scale,
        oy: canvasFaceY - sFC.y * scale,
      };
    };
    for (const key of SPRITE_KEYS) {
      fits[key] = fitFor(this.set[key]);
    }
    return fits;
  }

  // Mouth-aligned fit for any overlay sprite (phoneme inspection or
  // talk sprite). Computed each frame so the overlay's mouth lands
  // exactly on the currently-active emotion sprite's mouth.
  //
  // Two scale modes:
  //   "mouth": uniform scale = baseMouthW / overlayMouthW. Use when the
  //            source overlay draws a wider-than-rest mouth (exp_a) so
  //            its mouth corners land on the base mouth corners.
  //   "face":  uniform scale = canvasFaceSize / overlayFaceSize. Use
  //            when the overlay's mouth is naturally narrower or near
  //            the base mouth width (exp_o, exp_ee, exp_open) —
  //            mouth-width matching would scale these UP unnecessarily.
  // PHONEME_STRETCH_X applies a small horizontal-only stretch on top
  // of either mode (currently 1.0 = none).
  private overlayFitFor(
    profile: IdentityProfile,
    mode: "mouth" | "face",
  ): FitTransform {
    const currSprite = this.set[this.currSprite];
    const currFit = this.fits[this.currSprite];
    const currMouth = currSprite.features.mouth.center;
    const currMouthX = currMouth.x * currFit.scale + currFit.ox;
    const currMouthY = currMouth.y * currFit.scale + currFit.oy;

    let scale: number;
    if (mode === "mouth") {
      const baseMouthW = computeMouthWidth(currSprite) * currFit.scale;
      const overlayMouthW = computeMouthWidth(profile);
      scale = baseMouthW / overlayMouthW;
    } else {
      scale = this.canvasFaceSize / computeFaceSize(profile);
    }
    const scaleX = scale * PHONEME_STRETCH_X;
    const sMouth = profile.features.mouth.center;
    return {
      scale,
      scaleX,
      ox: currMouthX - sMouth.x * scaleX,
      oy: currMouthY - sMouth.y * scale,
    };
  }

  private phonemeFit(profile: IdentityProfile, key: PhonemeKey): FitTransform {
    return this.overlayFitFor(profile, PHONEME_FIT_MODE[key]);
  }

  draw(params: ExpressionParams): void {
    const now = performance.now();
    const dt = this.lastNow ? Math.max(1, now - this.lastNow) : 16;
    this.lastNow = now;
    if (this.transition < 1) {
      this.transition = Math.min(1, this.transition + dt / this.fadeDur);
    }

    const c = this.ctx;
    const cssW = this.canvasW / this.dpr;
    const cssH = this.canvasH / this.dpr;
    c.save();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, cssW, cssH);

    // Update phoneme cycle + speaking-fade. When phoneme sprites are loaded
    // and the avatar is speaking, the lower lip warp is suppressed and a
    // mouth-region overlay cycles through the phoneme sprites instead.
    this.updateLipsync(dt);

    // Motion-only params drive "alive" micro-motion (breath, gaze, head
    // tilt, mouth-open warp) without re-applying emotion deformations
    // the sprite already encodes. The warp's mouthOpen is suppressed
    // ONLY when a forced phoneme is active (say-* test buttons): in
    // that mode we want the artist-drawn viseme to read clearly, with
    // no warp fighting it. During audio / manual speaking we keep the
    // warp running so the lips physically open under the talk-sprite
    // overlay — the two stack into a bigger, more lifelike open mouth.
    const suppressMouthWarp = !!this.forcedPhoneme;
    const motion = motionOnly(params, this.currentEmotion, suppressMouthWarp);

    // 1. Crossfade between previous and current emotion sprites. Each sprite
    //    is rendered to the offscreen canvas at full opacity first, then
    //    blitted to the main canvas with the desired alpha. Without this
    //    indirection, the per-triangle clip inflation (≈0.5 px overlap) would
    //    produce alpha-compounded "grid lines" along triangle edges during
    //    crossfade.
    if (this.prevSprite && this.transition < 1) {
      this.renderProfileToOffscreen(
        this.set[this.prevSprite],
        motion,
        this.fits[this.prevSprite],
      );
      c.globalAlpha = 1 - this.transition;
      c.drawImage(this.offscreen, 0, 0, cssW, cssH);
    }
    this.renderProfileToOffscreen(
      this.set[this.currSprite],
      motion,
      this.fits[this.currSprite],
    );
    c.globalAlpha = this.prevSprite && this.transition < 1 ? this.transition : 1;
    c.drawImage(this.offscreen, 0, 0, cssW, cssH);
    c.globalAlpha = 1;

    // 2. Blink region overlay: clip to eye area on the *current* sprite, draw
    //    the eyes_closed sprite (warped, no eye-affecting params) on top. Only
    //    pixels inside the eye ellipses change → no whole-face flicker.
    //    Same offscreen trick — render eyes_closed at full alpha then blit.
    const blinkAmt = blinkAmount(params);
    if (blinkAmt > 0) {
      const closedMotion: ExpressionParams = {
        ...motion,
        // The closed-eye sprite already has the lids in the right place.
        // Don't let any eye-related warp params re-deform them.
        pupilDx: 0,
        pupilDy: 0,
        pupilScale: 1,
      };
      this.renderProfileToOffscreen(
        this.set.eyes_closed,
        closedMotion,
        this.fits.eyes_closed,
      );
      c.save();
      this.clipEyeRegions(this.set[this.currSprite], this.fits[this.currSprite]);
      c.globalAlpha = blinkAmt;
      c.drawImage(this.offscreen, 0, 0, cssW, cssH);
      c.globalAlpha = 1;
      c.restore();
    }

    // 3. Mouth overlay during speech. Two paths, mutually exclusive:
    //    a) forced phoneme — say-* test button picked a viseme; render
    //       it directly so the user can inspect the artwork.
    //    b) talk sprite — production speech path. A single open-mouth
    //       sprite (exp_open) is faded in over the base by speakingFade.
    //       The base sprite's mouth-open warp keeps running underneath,
    //       so the lip outline animates continuously and the talk
    //       sprite supplies the inner-mouth detail (teeth, tongue).
    //    No cycling between visemes — the cycling produced ghost /
    //    flicker artifacts that single-sprite cross-fade avoids.
    if (this.speakingFade > 0.02) {
      const overlayMotion: ExpressionParams = {
        ...motion,
        mouthOpen: 0,
        mouthCurve: 0,
        mouthWidth: 1,
      };
      let overlayProfile: IdentityProfile | undefined;
      let overlayFit: FitTransform | undefined;
      if (this.forcedPhoneme && this.phonemes?.[this.forcedPhoneme]) {
        const pkey = this.forcedPhoneme;
        overlayProfile = this.phonemes[pkey];
        overlayFit = this.phonemeFit(overlayProfile!, pkey);
      } else if (this.talkSprite) {
        overlayProfile = this.talkSprite;
        // Talk sprite uses face-mode fit — exp_open is drawn at natural
        // face proportions, so matching face height (rather than mouth
        // width) keeps it visually consistent with the base sprite.
        overlayFit = this.overlayFitFor(this.talkSprite, "face");
      }
      if (overlayProfile && overlayFit) {
        this.renderProfileToOffscreen(overlayProfile, overlayMotion, overlayFit);
        this.featherMouthMask(
          this.set[this.currSprite],
          this.fits[this.currSprite],
          overlayProfile,
          overlayFit,
        );
        c.globalAlpha = this.speakingFade;
        c.drawImage(this.offscreen, 0, 0, cssW, cssH);
        c.globalAlpha = 1;
      }
    }

    // 4. Procedural blush overlay (currently only `shy`, since it shares the
    //    neutral sprite). Smooth fade in/out via blushAlpha lerp.
    const blushTarget = this.currentEmotion === "shy" ? 1 : 0;
    this.blushAlpha += (blushTarget - this.blushAlpha) * Math.min(1, dt / 240);
    if (this.blushAlpha > 0.02) {
      this.drawBlush(this.set[this.currSprite], this.fits[this.currSprite], this.blushAlpha);
    }

    c.restore();
  }

  private updateLipsync(dt: number): void {
    if (this.audioDriven) {
      const floor = 0.035;
      const full = 0.18;
      const target = this.audioAmplitude <= floor
        ? 0
        : Math.max(0, Math.min(1, (this.audioAmplitude - floor) / (full - floor)));
      const tc = target > this.speakingFade ? 24 : 64;
      this.speakingFade += (target - this.speakingFade) * Math.min(1, dt / tc);
    } else {
      const target = this.speaking ? 1 : 0;
      this.speakingFade += (target - this.speakingFade) * Math.min(1, dt / 90);
    }
  }

  // Render any IdentityProfile (sprite or phoneme) to the shared offscreen
  // canvas at full opacity. Caller blits to main canvas with desired alpha.
  private renderProfileToOffscreen(
    profile: IdentityProfile,
    params: ExpressionParams,
    fit: FitTransform,
  ): void {
    const oc = this.offscreenCtx;
    const cssW = this.canvasW / this.dpr;
    const cssH = this.canvasH / this.dpr;
    oc.save();
    oc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    oc.clearRect(0, 0, cssW, cssH);
    drawWarpedProfile(oc, profile, params, fit);
    oc.restore();
  }

  private drawBlush(
    profile: IdentityProfile,
    fit: FitTransform,
    intensity: number,
  ): void {
    const c = this.ctx;
    // Cheek anchors derived from landmarks so blush lands on the actual
    // cheekbone area, no matter how the sprite is composed. We use the
    // midpoint between the eye-bottom and the mouth-corner on each side.
    const lm = profile.landmarks;
    const leftCheek = midpoint(lm[145], lm[61]);
    const rightCheek = midpoint(lm[374], lm[291]);
    const faceW = computeFaceWidth(profile) * fit.scale;
    const r = Math.max(20, faceW * 0.13);

    c.save();
    for (const cheek of [leftCheek, rightCheek]) {
      const cx = cheek.x * fit.scale + fit.ox;
      const cy = cheek.y * fit.scale + fit.oy;
      const grad = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(255, 110, 130, ${0.45 * intensity})`);
      grad.addColorStop(0.6, `rgba(255, 110, 130, ${0.18 * intensity})`);
      grad.addColorStop(1, "rgba(255, 110, 130, 0)");
      c.fillStyle = grad;
      c.beginPath();
      c.ellipse(cx, cy, r * 1.1, r * 0.8, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  private clipEyeRegions(profile: IdentityProfile, fit: FitTransform): void {
    const c = this.ctx;
    c.beginPath();
    for (const eye of [profile.features.leftEye, profile.features.rightEye]) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const i of eye.ringIdx) {
        const lm = profile.landmarks[i];
        const x = lm.x * fit.scale + fit.ox;
        const y = lm.y * fit.scale + fit.oy;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      // Inflate so the clip covers eyelashes/lid edges and hides any tiny
      // alignment drift between sprites.
      const rx = (maxX - minX) / 2 + 12;
      const ry = (maxY - minY) / 2 + 9;
      c.moveTo(cx + rx, cy);
      c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    }
    c.clip();
  }

  // Dual-zone mouth mask. Single-blur masks force a tradeoff between
  // hiding the base sprite's lips and hiding the phoneme→base skin tone
  // seam: a Gaussian-blurred ellipse never has both a flat alpha=1 core
  // *and* a wide soft outer feather. To get both we build the mask on a
  // separate canvas in two layers:
  //
  //   1. Blurred OUTER ellipse — extends well into cheek/chin skin so
  //      the seam where phoneme skin tone meets base skin tone is a wide
  //      gradient rather than a hard line. Without this, any AI tone
  //      drift between phoneme and base sprites is visible as a patch.
  //   2. Sharp INNER ellipse drawn on top, no blur — restores alpha=1
  //      across the entire base lip region so no base lip pixels can
  //      survive in the final composite.
  //
  // Bounds are computed asymmetrically: the TOP of the mask is pinned to
  // the base sprite's upper lip, while the BOTTOM extends to whichever
  // is lower of the base's lower lip and the active phoneme's lower lip.
  // Open visemes (exp_a) drop the jaw downward, so the mask needs to
  // grow downward only — letting it grow upward as well would push it
  // into the philtrum / nose area and produce visible artifacts there.
  // Horizontal bounds use the union (rarely an issue, but cheap insurance).
  private featherMouthMask(
    baseProfile: IdentityProfile,
    baseFit: FitTransform,
    phonemeProfile?: IdentityProfile,
    phonemeFit?: FitTransform,
  ): void {
    const collect = (
      profile: IdentityProfile,
      fit: FitTransform,
    ): { minX: number; maxX: number; minY: number; maxY: number } => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      const sx = fit.scaleX ?? fit.scale;
      const sy = fit.scale;
      const idx = [
        ...profile.features.mouth.outerIdx,
        ...profile.features.mouth.innerIdx,
      ];
      for (const i of idx) {
        const lm = profile.landmarks[i];
        const x = lm.x * sx + fit.ox;
        const y = lm.y * sy + fit.oy;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return { minX, maxX, minY, maxY };
    };
    const base = collect(baseProfile, baseFit);
    const phon =
      phonemeProfile && phonemeFit ? collect(phonemeProfile, phonemeFit) : null;

    const minX = phon ? Math.min(base.minX, phon.minX) : base.minX;
    const maxX = phon ? Math.max(base.maxX, phon.maxX) : base.maxX;
    // Top pinned to base — no upward growth into philtrum / nose.
    const topY = base.minY;
    // Bottom extends to whichever is lower (phoneme's open jaw or base).
    const bottomY = phon ? Math.max(base.maxY, phon.maxY) : base.maxY;

    const mouthW = maxX - minX;
    const mouthH = bottomY - topY;
    const cx = (minX + maxX) / 2;
    const cy = (topY + bottomY) / 2;

    // ry covers half the asymmetric height plus a small margin. Floor of
    // mouthW * 0.20 keeps closed visemes (exp_o) from going so tight the
    // base lip outline at cy ± ~0.13 mouthW gets exposed.
    const rxInner = mouthW * 0.58;
    const ryInner = Math.max(mouthW * 0.20, mouthH * 0.55 + mouthW * 0.04);
    const rxOuter = mouthW * 0.78;
    const ryOuter = Math.max(mouthW * 0.32, mouthH * 0.75 + mouthW * 0.08);
    const blurR = Math.max(8, mouthW * 0.10);

    const mc = this.maskCtx;
    const cssW = this.canvasW / this.dpr;
    const cssH = this.canvasH / this.dpr;

    mc.save();
    mc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    mc.clearRect(0, 0, cssW, cssH);
    mc.fillStyle = "rgba(0,0,0,1)";
    // Layer 1: blurred outer halo for the soft seam.
    mc.filter = `blur(${blurR}px)`;
    mc.beginPath();
    mc.ellipse(cx, cy, rxOuter, ryOuter, 0, 0, Math.PI * 2);
    mc.fill();
    // Layer 2: sharp inner core, drawn on top so alpha is exactly 1
    // across the lip region.
    mc.filter = "none";
    mc.beginPath();
    mc.ellipse(cx, cy, rxInner, ryInner, 0, 0, Math.PI * 2);
    mc.fill();
    mc.restore();

    const oc = this.offscreenCtx;
    oc.save();
    oc.setTransform(1, 0, 0, 1, 0, 0);
    oc.globalCompositeOperation = "destination-in";
    oc.drawImage(this.maskCanvas, 0, 0);
    oc.restore();
  }
}

// Map an Emotion to the sprite key used to render it. Emotions with no
// dedicated sprite fall back to neutral (we can layer procedural overlays
// later if needed).
function pickEmotionSprite(e: Emotion): SpriteKey {
  if (e === "happy" || e === "sad" || e === "angry" || e === "surprised") {
    return e;
  }
  return "neutral";
}

// Strip out emotion-driven params; keep only the "alive" motion channels
// (gaze + head micro-motion + breathing + talking mouth flap).
// `shy` damps head motion further so it reads as bashful / inward.
// `suppressMouthWarp` zeroes the mouth-flap warp so the phoneme overlay
// can take over; without this the underlying sprite's mouth would also
// distort, fighting the artist-drawn phoneme shape on top.
function motionOnly(
  params: ExpressionParams,
  emotion: Emotion,
  suppressMouthWarp: boolean,
): ExpressionParams {
  const headScale = emotion === "shy" ? 0.35 : 1;
  return {
    ...baseExpression,
    pupilDx: params.pupilDx,
    pupilDy: params.pupilDy,
    pupilScale: params.pupilScale,
    headTilt: params.headTilt * headScale,
    headBobY: params.headBobY * headScale,
    mouthOpen: suppressMouthWarp ? 0 : params.mouthOpen * 0.5,
  };
}

// 0..1 — how "closed" the eyes are for the blink overlay. Smooth ramp from
// 0 at eyeOpen=0.5 to 1 at eyeOpen=0.
function blinkAmount(params: ExpressionParams): number {
  const open = params.eyeOpen;
  if (open >= 0.5) return 0;
  if (open <= 0) return 1;
  const t = (0.5 - open) / 0.5;
  return t * t * (3 - 2 * t); // smoothstep
}

function computeFaceSize(p: IdentityProfile): number {
  let topY = Infinity;
  let botY = -Infinity;
  for (const i of p.features.faceOvalIdx) {
    const lm = p.landmarks[i];
    topY = Math.min(topY, lm.y);
    botY = Math.max(botY, lm.y);
  }
  return Math.max(1, botY - topY);
}

function computeFaceWidth(p: IdentityProfile): number {
  let leftX = Infinity;
  let rightX = -Infinity;
  for (const i of p.features.faceOvalIdx) {
    const lm = p.landmarks[i];
    leftX = Math.min(leftX, lm.x);
    rightX = Math.max(rightX, lm.x);
  }
  return Math.max(1, rightX - leftX);
}

function computeMouthWidth(p: IdentityProfile): number {
  let leftX = Infinity;
  let rightX = -Infinity;
  for (const i of p.features.mouth.outerIdx) {
    const lm = p.landmarks[i];
    leftX = Math.min(leftX, lm.x);
    rightX = Math.max(rightX, lm.x);
  }
  return Math.max(1, rightX - leftX);
}

function midpoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
