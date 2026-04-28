import type { ExpressionParams } from "../templates/cartoon.js";
import type { Point } from "../types/index.js";
import { clamp } from "../utils/clock.js";
import { LOWER_LIP_LANDMARKS } from "./landmarkIndices.js";
import type {
  EyeFeature,
  HeadPose,
  IdentityProfile,
  MouthFeature,
} from "./IdentityEngine.js";

// SPEC §4.4 — Translates ExpressionParams + IdentityProfile into per-vertex
// pixel positions used by the PhotoRenderer mesh warp.
//
// All deformations run in *feature-local 2D axes* (eye's own outer→inner axis,
// mouth's own left→right axis, etc.) instead of world XY. That's what makes
// non-frontal photos work: when the face rolls/yaws/tilts, the eye axis tilts
// with it, and "perpendicular squash" still closes the eye correctly.

interface Vec2 {
  x: number;
  y: number;
}

const ZERO: Vec2 = { x: 0, y: 0 };

// Decompose offset (v - center) into (along-axis, perp-axis) scalar components.
// Reconstruct with `centerX + along*ax.x + perp*ay.x` etc.
function project(v: Point, center: Point, ax: Vec2, ay: Vec2): { along: number; perp: number } {
  const dx = v.x - center.x;
  const dy = v.y - center.y;
  return {
    along: dx * ax.x + dy * ax.y,
    perp: dx * ay.x + dy * ay.y,
  };
}

function rebuild(center: Point, along: number, perp: number, ax: Vec2, ay: Vec2): Point {
  return {
    x: center.x + along * ax.x + perp * ay.x,
    y: center.y + along * ax.y + perp * ay.y,
  };
}

// Build a feature's local frame from its two endpoints. Aligns local-Y with
// the global face_y direction (toward chin) so "perp > 0" always means
// "below the feature" no matter how the head is rotated/tilted.
function localFrame(a: Point, b: Point, faceY: Vec2): { ax: Vec2; ay: Vec2; len: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ax: Vec2 = { x: dx / len, y: dy / len };
  // 90° CCW rotation gives one perpendicular; flip if it doesn't match faceY.
  const ayCCW: Vec2 = { x: -ax.y, y: ax.x };
  const align = ayCCW.x * faceY.x + ayCCW.y * faceY.y;
  const ay = align >= 0 ? ayCCW : { x: -ayCCW.x, y: -ayCCW.y };
  return { ax, ay, len };
}

export function deformMesh(
  profile: IdentityProfile,
  params: ExpressionParams,
): Point[] {
  const faceH = computeFaceH(profile);
  const pose = profile.headPose;

  // 1. landmark-level deformations (each feature in its own local axes)
  const lm = profile.landmarks.map((p) => ({ x: p.x, y: p.y }));
  deformEye(lm, profile.features.leftEye, params, pose);
  deformEye(lm, profile.features.rightEye, params, pose);
  deformMouth(lm, profile.features.mouth, params, pose, faceH);
  deformBrows(lm, params, pose, faceH);

  // 2. build mesh verts (subset landmarks + static image-corner anchors).
  // Anchors must be DEEP-COPIED here because applyHeadTransform mutates
  // verts[i].x/.y in place. If we passed `profile.meshVerts[i]` by reference,
  // the transform would permanently overwrite the stored neutral position
  // and the next frame would deform from the drifted state — head bob /
  // tilt would accumulate across frames into a runaway "ghost" position.
  // (Image-corner anchors with idx === -1 are skipped by the transform, so a
  // reference would technically work, but copying everything keeps the
  // invariant simple.)
  const verts: Point[] = new Array(profile.meshVerts.length);
  for (let i = 0; i < profile.meshLandmarkIdx.length; i++) {
    const idx = profile.meshLandmarkIdx[i];
    if (idx >= 0) {
      verts[i] = lm[idx]; // landmarks are already fresh copies above
    } else {
      const src = profile.meshVerts[i];
      verts[i] = { x: src.x, y: src.y };
    }
  }

  // 3. global head transform (uses face-local Y for the bob direction)
  applyHeadTransform(verts, profile, params, pose);
  return verts;
}

// ---------- Eyes ----------
function deformEye(
  lm: Point[],
  eye: EyeFeature,
  p: ExpressionParams,
  pose: HeadPose,
): void {
  const o = lm[eye.outer];
  const inn = lm[eye.inner];
  const eyeCenter: Point = { x: (o.x + inn.x) / 2, y: (o.y + inn.y) / 2 };
  // Eye-local frame: x = outer→inner (this eye's actual orientation in image),
  // y = perpendicular aligned with face_y.
  const { ax, ay, len: eyeWidth } = localFrame(o, inn, pose.faceY);

  // Vertical span of the eye in eye-local coords.
  let topPerp = Infinity;
  let botPerp = -Infinity;
  for (const i of eye.ringIdx) {
    const { perp } = project(lm[i], eyeCenter, ax, ay);
    if (perp < topPerp) topPerp = perp;
    if (perp > botPerp) botPerp = perp;
  }
  const eyeHeight = Math.max(2, botPerp - topPerp);

  const open = clamp(p.eyeOpen, 0, 1.6);
  const arc = clamp(p.eyeArc, 0, 0.8);
  const squash = clamp(open - arc * 0.5, 0, 1.4);

  // Eyelid: squash perp components, leave along untouched.
  for (const i of eye.ringIdx) {
    const { along, perp } = project(lm[i], eyeCenter, ax, ay);
    const sign = perp < 0 ? -1 : 1;
    let newPerp = perp * squash;
    if (arc > 0) newPerp += sign * (-arc * 0.15 * eyeHeight);
    const out = rebuild(eyeCenter, along, newPerp, ax, ay);
    lm[i].x = out.x;
    lm[i].y = out.y;
  }

  // Iris: translate using the GLOBAL face axes (pose.faceX / pose.faceY),
  // NOT each eye's outer→inner axis. The two eyes' local axes point toward
  // the nose (left eye's axis points image-left, right eye's axis points
  // image-right) — so applying pupilDx along the eye-local axis would send
  // the irises in OPPOSITE directions and look cross-eyed. Face-global axes
  // keep both eyes moving the same way in image space.
  // The iris also gets a uniform radial scale by `squash` so it stays a
  // perfect circle and shrinks behind the lid as the eye closes.
  const origCenter: Point = { x: lm[eye.irisCenter].x, y: lm[eye.irisCenter].y };
  // Gaze magnitude: reduced from 0.18 to keep the iris ring well inside the
  // synthetic outer anchor ring (placed at 2.0× iris radius). With max
  // pupilDx ≈ 0.9 and typical eyeWidth ≈ 60px, gaze travels ~5px while iris
  // radius is ~10px and gap to outer anchor is ~10px — comfortable margin.
  const gazeX = p.pupilDx * eyeWidth * 0.1;
  const gazeY = p.pupilDy * eyeHeight * 0.1;
  const newCenter: Point = {
    x: origCenter.x + gazeX * pose.faceX.x + gazeY * pose.faceY.x,
    y: origCenter.y + gazeX * pose.faceX.y + gazeY * pose.faceY.y,
  };
  const irisScale = clamp(squash, 0, 1);
  for (const i of irisRingFor(eye.irisCenter)) {
    const ldx = lm[i].x - origCenter.x;
    const ldy = lm[i].y - origCenter.y;
    lm[i].x = newCenter.x + ldx * irisScale;
    lm[i].y = newCenter.y + ldy * irisScale;
  }
}

function irisRingFor(centerIdx: number): number[] {
  if (centerIdx === 468) return [468, 469, 470, 471, 472];
  if (centerIdx === 473) return [473, 474, 475, 476, 477];
  return [centerIdx];
}

// ---------- Mouth ----------
function deformMouth(
  lm: Point[],
  mouth: MouthFeature,
  p: ExpressionParams,
  pose: HeadPose,
  faceH: number,
): void {
  const left = lm[mouth.left];
  const right = lm[mouth.right];
  const top = lm[mouth.top];
  const bot = lm[mouth.bottom];
  // Mouth center: midpoint of corners (works on profile faces too — top/bot
  // would skew on heavy yaw because one becomes invisible).
  const cx = (left.x + right.x) / 2;
  const cy = (left.y + right.y) / 2;
  // Make the center sit at the lip midline by averaging in the top/bot too.
  const mouthCenter: Point = {
    x: (cx + (top.x + bot.x) / 2) / 2,
    y: (cy + (top.y + bot.y) / 2) / 2,
  };
  // Mouth-local frame: x = left→right corner, y = perp aligned with face_y.
  const { ax, ay, len: mouthW } = localFrame(left, right, pose.faceY);

  const curve = clamp(p.mouthCurve, -1, 1);
  const open = clamp(p.mouthOpen, 0, 1);
  const widthScale = clamp(p.mouthWidth, 0.6, 1.3);

  const cornerLift = curve * faceH * 0.035;
  const openBot = open * faceH * 0.06;

  const all = [...mouth.outerIdx, ...mouth.innerIdx];

  // Classify by landmark INDEX (MediaPipe topology), not by perp value.
  // Earlier the perp-based classification mis-categorised mouth corners
  // (perp ≈ 0) and inner-lip points whose perp jittered around the lip
  // line — they got partial opening drop, which dragged the upper lip
  // visually. With a hardcoded "lower lip" set, the upper lip ring + both
  // pairs of corners are guaranteed static during speech.
  for (const i of all) {
    let { along, perp } = project(lm[i], mouthCenter, ax, ay);
    along *= widthScale;
    const horizT = clamp(Math.abs(along) / (mouthW / 2 + 1e-3), 0, 1);
    perp -= cornerLift * horizT;
    if (LOWER_LIP_LANDMARKS.has(i)) {
      perp += openBot * (1 - horizT * 0.3);
    }
    // Everything else (upper ring + corners) stays put for opening.
    const out = rebuild(mouthCenter, along, perp, ax, ay);
    lm[i].x = out.x;
    lm[i].y = out.y;
  }
}

// ---------- Brows ----------
function deformBrows(
  lm: Point[],
  p: ExpressionParams,
  pose: HeadPose,
  faceH: number,
): void {
  const browL = [70, 63, 105, 66, 107]; // outer→inner (left brow)
  const browR = [336, 296, 334, 293, 300]; // inner→outer (right brow)
  const lift = p.browLift * faceH * 0.04;
  const tilt = p.browTilt;
  applyBrow(lm, browL, lift, tilt, +1, pose);
  applyBrow(lm, browR, lift, tilt, -1, pose);
}

function applyBrow(
  lm: Point[],
  idx: number[],
  lift: number,
  tilt: number,
  innerSign: number,
  pose: HeadPose,
): void {
  // Brow-local frame: x = outer→inner of THIS brow (image space), y = face_y.
  const a = lm[idx[0]];
  const b = lm[idx[idx.length - 1]];
  const { ax, ay } = localFrame(a, b, pose.faceY);
  let cx = 0;
  let cy = 0;
  for (const i of idx) {
    cx += lm[i].x;
    cy += lm[i].y;
  }
  cx /= idx.length;
  cy /= idx.length;
  const center: Point = { x: cx, y: cy };

  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    let { along, perp } = project(lm[i], center, ax, ay);
    // Lift: shift perp toward face-up.
    perp -= lift;
    // Tilt: positive = inner end goes down (angry). Map k=0..len-1 to t=-1..1.
    const t = (k / (idx.length - 1)) * 2 - 1;
    const innerness = innerSign * t;
    perp += tilt * innerness * 8;
    const out = rebuild(center, along, perp, ax, ay);
    lm[i].x = out.x;
    lm[i].y = out.y;
  }
  void ZERO; // keep ZERO referenced for future helpers
}

// ---------- Head transform ----------
// Rigid head + body anchor. The challenge: nod/shake should move the entire
// head (face + hair) as one unit, but the shoulders should stay put.
//
// Trick: we use *anisotropic* distance from the chin pivot. Above-chin (face
// + hair) uses normal Euclidean distance; below-chin (neck → shoulder) is
// scaled ~3× so it falls off the falloff curve very quickly. Result:
//   - Hair top   (≈1.3 × faceH above chin) → full motion ✓
//   - Forehead/eyes/cheeks → full motion ✓
//   - Neck stub  (≈0.3 below chin) → mostly full motion (slight stretch)
//   - Shoulder   (≈1.0 below chin) → effectively outside falloff ✓
//   - Image edges → static ✓
// The whole head translates/rotates as a rigid piece without yanking the
// shoulders. This is the same shape we'd get from a head-only segmentation
// mask but is computed entirely from landmarks.
function applyHeadTransform(
  verts: Point[],
  profile: IdentityProfile,
  p: ExpressionParams,
  pose: HeadPose,
): void {
  if (Math.abs(p.headTilt) < 1e-4 && Math.abs(p.headBobY) < 0.01) return;

  let cx = 0;
  let chinY = -Infinity;
  let topY = Infinity;
  for (const i of profile.features.faceOvalIdx) {
    cx += profile.landmarks[i].x;
    chinY = Math.max(chinY, profile.landmarks[i].y);
    topY = Math.min(topY, profile.landmarks[i].y);
  }
  cx /= profile.features.faceOvalIdx.length;
  const faceH = chinY - topY;
  const cy = chinY;
  // Cover face + hair (typically extends to ~1.3 × faceH above chin).
  const fullR = faceH * 1.35;
  const fadeR = faceH * 1.7;
  const fadeSpan = Math.max(1, fadeR - fullR);
  // Below-chin scaling: makes shoulder fall outside the fade zone fast.
  const belowK = 3.0;

  const cos = Math.cos(p.headTilt);
  const sin = Math.sin(p.headTilt);
  const bobX = p.headBobY * pose.faceY.x;
  const bobY = p.headBobY * pose.faceY.y;

  for (let i = 0; i < verts.length; i++) {
    const idx = profile.meshLandmarkIdx[i];
    // -1 = image-corner anchor: stays static.
    if (idx === -1) continue;
    const v = verts[i];
    const dx = v.x - cx;
    const dy = v.y - cy;
    let w: number;
    if (idx === -2) {
      // Hair anchor — explicitly part of the rigid head, 100% motion no
      // matter where it lands. Bypassing falloff prevents the face/hair
      // boundary from getting torn (face moves 100% but hair anchor in the
      // fade zone moves <100% → "face collapse" distortion).
      w = 1;
    } else {
      // Real face landmark — anisotropic distance falloff so the head moves
      // as a unit but shoulders / image edges stay still.
      const dyEff = dy < 0 ? dy : dy * belowK;
      const dist = Math.hypot(dx, dyEff);
      if (dist >= fadeR) continue;
      if (dist > fullR) {
        const t = 1 - (dist - fullR) / fadeSpan;
        w = t * t * (3 - 2 * t);
      } else {
        w = 1;
      }
    }
    const rx = cx + dx * cos - dy * sin + bobX;
    const ry = cy + dx * sin + dy * cos + bobY;
    v.x = v.x + (rx - v.x) * w;
    v.y = v.y + (ry - v.y) * w;
  }
}

function computeFaceH(profile: IdentityProfile): number {
  let chinY = -Infinity;
  let topY = Infinity;
  for (const i of profile.features.faceOvalIdx) {
    chinY = Math.max(chinY, profile.landmarks[i].y);
    topY = Math.min(topY, profile.landmarks[i].y);
  }
  return Math.max(1, chinY - topY);
}
