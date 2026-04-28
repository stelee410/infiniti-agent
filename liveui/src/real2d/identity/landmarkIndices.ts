// MediaPipe FaceLandmarker (478-point topology) — indices we care about.
// Reference: https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/python/solutions/face_mesh_connections.py

// Eye outlines (clockwise from outer corner). 6-point coarse rings used for
// our subset mesh — finer rings exist (16 points) but 6 is enough for warp.
export const LEFT_EYE_RING = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
export const RIGHT_EYE_RING = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249];

// Cardinal eye anchors (used by the deformer to compute eye-center / eye-axis).
export const LEFT_EYE_OUTER = 33;
export const LEFT_EYE_INNER = 133;
export const LEFT_EYE_TOP = 159;
export const LEFT_EYE_BOTTOM = 145;
export const RIGHT_EYE_OUTER = 263;
export const RIGHT_EYE_INNER = 362;
export const RIGHT_EYE_TOP = 386;
export const RIGHT_EYE_BOTTOM = 374;

// Iris (Tasks model includes iris landmarks 468..477)
export const LEFT_IRIS = [468, 469, 470, 471, 472];
export const RIGHT_IRIS = [473, 474, 475, 476, 477];
export const LEFT_IRIS_CENTER = 468;
export const RIGHT_IRIS_CENTER = 473;

// Eyebrows
export const LEFT_BROW = [70, 63, 105, 66, 107]; // outer→inner
export const RIGHT_BROW = [336, 296, 334, 293, 300]; // inner→outer

// Lips
export const LIPS_OUTER = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, // upper outer L→R
  291, 375, 321, 405, 314, 17, 84, 181, 91, 146, // lower outer R→L
];
export const LIPS_INNER = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415,
  308, 324, 318, 402, 317, 14, 87, 178, 88, 95,
];
export const MOUTH_LEFT = 61;
export const MOUTH_RIGHT = 291;
export const MOUTH_TOP = 13;
export const MOUTH_BOTTOM = 14;

// The set of lip landmarks that move WITH THE JAW during speech (i.e. the
// lower lip ring, both outer and inner). Mouth corners (61/291/78/308) and
// the entire upper lip ring are intentionally excluded — they stay
// anchored. Hardcoded by MediaPipe topology so we don't depend on per-image
// projection geometry to classify "is this a lower-lip point?".
export const LOWER_LIP_LANDMARKS: ReadonlySet<number> = new Set<number>([
  // outer lower (R→L from right corner exclusive)
  375, 321, 405, 314, 17, 84, 181, 91, 146,
  // inner lower (R→L from right inner corner exclusive)
  324, 318, 402, 317, 14, 87, 178, 88, 95,
]);

// Face oval — coarse 12-point sample so we don't over-triangulate the face contour.
export const FACE_OVAL_COARSE = [
  10, 338, 297, 332, 284, 251, 389, // right side, top→bottom-right
  454, 323, 361, 288, 397, // jaw right
  365, 379, 378, 400, 152, // chin
  148, 176, 149, 150, 136, // jaw left
  172, 58, 132, 93, 234, // left side
  127, 162, 21, 54, 103, 67, 109, // top-left back to top
];

// Nose (a few anchor points)
export const NOSE = [1, 4, 5, 6, 168, 195, 197, 2, 98, 327];

// All subset indices we feed into Delaunator. Order doesn't matter — we just
// need the mesh to cover face features densely.
export function buildSubsetIndices(): number[] {
  const set = new Set<number>();
  for (const i of FACE_OVAL_COARSE) set.add(i);
  for (const i of LEFT_EYE_RING) set.add(i);
  for (const i of RIGHT_EYE_RING) set.add(i);
  for (const i of LEFT_BROW) set.add(i);
  for (const i of RIGHT_BROW) set.add(i);
  for (const i of LIPS_OUTER) set.add(i);
  for (const i of LIPS_INNER) set.add(i);
  for (const i of NOSE) set.add(i);
  // include iris ring for gaze deformation
  for (const i of LEFT_IRIS) set.add(i);
  for (const i of RIGHT_IRIS) set.add(i);
  return [...set].sort((a, b) => a - b);
}
