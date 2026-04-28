import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import Delaunator from "delaunator";
import {
  buildSubsetIndices,
  FACE_OVAL_COARSE,
  LEFT_EYE_BOTTOM,
  LEFT_EYE_INNER,
  LEFT_EYE_OUTER,
  LEFT_EYE_RING,
  LEFT_EYE_TOP,
  LEFT_IRIS,
  LEFT_IRIS_CENTER,
  MOUTH_BOTTOM,
  MOUTH_LEFT,
  MOUTH_RIGHT,
  MOUTH_TOP,
  RIGHT_EYE_BOTTOM,
  RIGHT_EYE_INNER,
  RIGHT_EYE_OUTER,
  RIGHT_EYE_RING,
  RIGHT_EYE_TOP,
  RIGHT_IRIS,
  RIGHT_IRIS_CENTER,
} from "./landmarkIndices.js";
import type { Point } from "../types/index.js";

export interface IdentityProfile {
  imageBitmap: ImageBitmap;
  imageW: number;
  imageH: number;
  landmarks: Point[];
  meshVerts: Point[];
  meshLandmarkIdx: number[];
  triangles: Uint32Array;
  features: {
    leftEye: EyeFeature;
    rightEye: EyeFeature;
    mouth: MouthFeature;
    faceOvalIdx: number[];
  };
  // SPEC §4.1 — face-local 2D frame in image space, derived from landmarks.
  // Lets the deformer apply expressions in face-local coordinates so non-frontal
  // photos still warp correctly (squash an eye perpendicular to its own axis,
  // not perpendicular to image-Y).
  headPose: HeadPose;
  // Raw 4×4 head transform from MediaPipe (kept for diagnostics & future 3D use).
  headMatrix: Float32Array | null;
}

export interface HeadPose {
  faceX: Point; // unit vec — face's anatomical-right direction in image space
  faceY: Point; // unit vec — face's anatomical-down direction (toward chin)
  faceCenter: Point; // origin for the face-local frame
  yaw: number; // approx [-1..1], 0 = frontal; sign: + = subject turned to their right
}

export interface EyeFeature {
  ringIdx: number[]; // landmark indices around the eye
  outer: number;
  inner: number;
  top: number;
  bottom: number;
  center: Point;
  irisCenter: number;
}

export interface MouthFeature {
  outerIdx: number[]; // landmark indices for outer lip ring
  innerIdx: number[];
  left: number;
  right: number;
  top: number;
  bottom: number;
  center: Point;
}

export interface IdentityEngineConfig {
  // Where MediaPipe wasm files live. Default: jsDelivr CDN (cached after first
  // load). Override to a local /public path for offline use.
  wasmPath?: string;
  // Where the .task model lives. Default: Google CDN.
  modelPath?: string;
}

const DEFAULT_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
const DEFAULT_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

let landmarkerSingleton: Promise<FaceLandmarker> | null = null;

async function getLandmarker(cfg: IdentityEngineConfig): Promise<FaceLandmarker> {
  if (!landmarkerSingleton) {
    landmarkerSingleton = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(cfg.wasmPath ?? DEFAULT_WASM);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: cfg.modelPath ?? DEFAULT_MODEL,
          delegate: "GPU",
        },
        runningMode: "IMAGE",
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true,
      });
    })();
  }
  return landmarkerSingleton;
}

export class IdentityEngine {
  constructor(private cfg: IdentityEngineConfig = {}) {}

  async detectFromImage(img: HTMLImageElement): Promise<IdentityProfile> {
    const landmarker = await getLandmarker(this.cfg);
    if (!img.complete) {
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("image load failed"));
      });
    }
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const result = landmarker.detect(img);
    if (!result.faceLandmarks || result.faceLandmarks.length === 0) {
      throw new Error("LANDMARK_FAILED: no face detected");
    }
    const lm = result.faceLandmarks[0];
    const landmarks: Point[] = lm.map((p) => ({ x: p.x * w, y: p.y * h }));

    // 4×4 head pose matrix (column-major). Optional — we use landmark-derived
    // axes for the actual warp, but keep this for diagnostics.
    let headMatrix: Float32Array | null = null;
    const matrices = result.facialTransformationMatrixes;
    if (matrices && matrices.length > 0 && matrices[0].data) {
      headMatrix = new Float32Array(matrices[0].data);
    }

    const bitmap = await createImageBitmap(img);

    return this.buildProfile(landmarks, bitmap, w, h, headMatrix);
  }

  private buildProfile(
    landmarks: Point[],
    bitmap: ImageBitmap,
    w: number,
    h: number,
    headMatrix: Float32Array | null,
  ): IdentityProfile {
    const subset = buildSubsetIndices();
    const meshVerts: Point[] = [];
    const meshLandmarkIdx: number[] = [];
    for (const idx of subset) {
      meshVerts.push(landmarks[idx]);
      meshLandmarkIdx.push(idx);
    }
    // Add image-corner / edge-mid anchors so the mesh covers the whole canvas
    // and edges stay pinned (otherwise the warp would chop off shoulders).
    const anchors: Point[] = [
      { x: 0, y: 0 },
      { x: w / 2, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h / 2 },
      { x: w, y: h },
      { x: w / 2, y: h },
      { x: 0, y: h },
      { x: 0, y: h / 2 },
    ];
    for (const a of anchors) {
      meshVerts.push(a);
      meshLandmarkIdx.push(-1);
    }

    // Hair anchors — synthetic vertices arranged in a half-circle above the
    // chin pivot so the rigid head region extends past the face oval to
    // include the hair. Without these, the only mesh vertices in the hair
    // region are at the image corners (which never move), so any face motion
    // stretches the (face_oval ↔ image_corner) triangles and distorts hair.
    // With hair anchors moving rigidly with the face (idx === -2), the hair
    // gets full motion while only the (hair_anchor ↔ image_corner) triangles
    // — which cover the background outside the head — stretch.
    let faceCenterX = 0;
    let chinY = -Infinity;
    let topYface = Infinity;
    for (const i of FACE_OVAL_COARSE) {
      faceCenterX += landmarks[i].x;
      chinY = Math.max(chinY, landmarks[i].y);
      topYface = Math.min(topYface, landmarks[i].y);
    }
    faceCenterX /= FACE_OVAL_COARSE.length;
    const faceH = chinY - topYface;
    const hairR = faceH * 1.5; // outside hair edge for typical head shots
    const HAIR_ANCHORS = 9;
    for (let k = 0; k < HAIR_ANCHORS; k++) {
      const theta = (k / (HAIR_ANCHORS - 1)) * Math.PI; // 0..π — half-circle above chin
      meshVerts.push({
        x: faceCenterX + hairR * Math.cos(theta),
        y: chinY - hairR * Math.sin(theta),
      });
      meshLandmarkIdx.push(-2); // moves with head transform (rigid head region)
    }

    // Iris outer anchors — synthetic stationary vertices in a ring just
    // outside each iris. Without them, the gaze translation of the iris ring
    // is absorbed by the wide iris→eyelid triangles, distorting the iris
    // into an oval. With static outer anchors creating an annulus around the
    // iris, the iris ring translates rigidly inside and stays circular.
    //
    // Sizing: ratio of 2.0 gives a generous gap (≈ iris radius) between
    // iris ring and outer anchor — wide enough that gaze translation never
    // makes the iris ring cross the outer anchors (which would invert the
    // annulus triangles and produce uglier artifacts than the original
    // problem). 8 anchors at 22.5° offset interleave between the 4 iris
    // ring points (which sit at 0/90/180/270°) so neither set is collinear
    // with the other for Delaunay.
    const irisOuterRatio = 2.0;
    const irisOuterCount = 8;
    for (const irisRing of [LEFT_IRIS, RIGHT_IRIS]) {
      const centerIdx = irisRing[0];
      const ix = landmarks[centerIdx].x;
      const iy = landmarks[centerIdx].y;
      let ir = 0;
      for (let k = 1; k < irisRing.length; k++) {
        const lm = landmarks[irisRing[k]];
        ir += Math.hypot(lm.x - ix, lm.y - iy);
      }
      ir = (ir / (irisRing.length - 1)) * irisOuterRatio;
      for (let k = 0; k < irisOuterCount; k++) {
        const theta = ((k + 0.5) / irisOuterCount) * 2 * Math.PI;
        meshVerts.push({
          x: ix + ir * Math.cos(theta),
          y: iy + ir * Math.sin(theta),
        });
        meshLandmarkIdx.push(-2);
      }
    }

    const flat = new Float64Array(meshVerts.length * 2);
    for (let i = 0; i < meshVerts.length; i++) {
      flat[i * 2] = meshVerts[i].x;
      flat[i * 2 + 1] = meshVerts[i].y;
    }
    const delaunay = new Delaunator(flat);

    const features = {
      leftEye: this.eyeFeature(landmarks, LEFT_EYE_RING, LEFT_EYE_OUTER, LEFT_EYE_INNER, LEFT_EYE_TOP, LEFT_EYE_BOTTOM, LEFT_IRIS_CENTER),
      rightEye: this.eyeFeature(landmarks, RIGHT_EYE_RING, RIGHT_EYE_OUTER, RIGHT_EYE_INNER, RIGHT_EYE_TOP, RIGHT_EYE_BOTTOM, RIGHT_IRIS_CENTER),
      mouth: this.mouthFeature(landmarks),
      faceOvalIdx: FACE_OVAL_COARSE.slice(),
    };

    const headPose = computeHeadPose(landmarks, headMatrix);

    return {
      imageBitmap: bitmap,
      imageW: w,
      imageH: h,
      landmarks,
      meshVerts,
      meshLandmarkIdx,
      triangles: delaunay.triangles,
      features,
      headPose,
      headMatrix,
    };
  }

  private eyeFeature(
    lm: Point[],
    ring: number[],
    outer: number,
    inner: number,
    top: number,
    bottom: number,
    irisCenter: number,
  ): EyeFeature {
    const center = avg(lm, ring);
    return { ringIdx: ring.slice(), outer, inner, top, bottom, center, irisCenter };
  }

  private mouthFeature(lm: Point[]): MouthFeature {
    // Use only the principal anchor indices we already track in landmarkIndices.
    const outerIdx = [
      61, 185, 40, 39, 37, 0, 267, 269, 270, 409,
      291, 375, 321, 405, 314, 17, 84, 181, 91, 146,
    ];
    const innerIdx = [
      78, 191, 80, 81, 82, 13, 312, 311, 310, 415,
      308, 324, 318, 402, 317, 14, 87, 178, 88, 95,
    ];
    const center = avg(lm, outerIdx);
    return {
      outerIdx,
      innerIdx,
      left: MOUTH_LEFT,
      right: MOUTH_RIGHT,
      top: MOUTH_TOP,
      bottom: MOUTH_BOTTOM,
      center,
    };
  }
}

function avg(lm: Point[], idx: number[]): Point {
  let sx = 0;
  let sy = 0;
  for (const i of idx) {
    sx += lm[i].x;
    sy += lm[i].y;
  }
  return { x: sx / idx.length, y: sy / idx.length };
}

// Builds the face-local 2D frame from landmarks. The "face right" axis is
// derived from the eye-corner line (subject's left eye outer → subject's right
// eye outer); face-down is its 90° clockwise rotation, aligned so it points
// toward the chin. This is a 2D image-space frame — exactly what the warp
// needs, and it stays correct under head roll / mild yaw / pitch because the
// landmarks themselves rotate with the face.
//
// We *also* receive the 4×4 head matrix from MediaPipe; it's stored in the
// profile but the deformer prefers the landmark-derived axes because they're
// already in image space (no projection guesswork required).
function computeHeadPose(
  landmarks: Point[],
  headMatrix: Float32Array | null,
): HeadPose {
  // Subject's left/right eye OUTER corners. lm[33] = subject-left-eye outer
  // (sits on the image-right for a frontal selfie). lm[263] = subject-right-eye
  // outer. So lm[33] - lm[263] points toward the subject's left side, which
  // for a frontal face is image-+x. Treat that as the +faceX (face's right
  // direction in subject-anatomical terms) — note the historical "left/right"
  // is from the subject, not the viewer.
  const lLeftEye = landmarks[33];
  const lRightEye = landmarks[263];
  let dx = lLeftEye.x - lRightEye.x;
  let dy = lLeftEye.y - lRightEye.y;
  let len = Math.hypot(dx, dy) || 1;
  const faceX: Point = { x: dx / len, y: dy / len };
  // 90° CCW rotation of (a, b) is (-b, a). For frontal (1, 0) → (0, 1)
  // which is image-down — exactly the chin direction we want.
  const faceY: Point = { x: -faceX.y, y: faceX.x };

  // Eye midpoint as a stable face center (works on partial profile too).
  const faceCenter: Point = {
    x: (lLeftEye.x + lRightEye.x) / 2,
    y: (lLeftEye.y + lRightEye.y) / 2,
  };

  // Yaw estimate: ratio of detected eye-line length to the canonical face
  // width (forehead-to-chin distance × ~0.5). When face turns, eye-line
  // foreshortens. If matrix is available we can sign yaw from it.
  let yaw = 0;
  if (headMatrix && headMatrix.length >= 16) {
    // Column 2 = face's +Z axis (forward) in camera space (column-major).
    // Z's image-x component reveals yaw direction & magnitude.
    const zx = headMatrix[8];
    yaw = Math.max(-1, Math.min(1, zx));
  }

  return { faceX, faceY, faceCenter, yaw };
}
