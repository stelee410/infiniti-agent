import type { Emotion } from "../types/index.js";

// Programmatic cartoon avatar template (MVP).
// All coordinates are in template space [0..1] × [0..1] and scaled at draw time.
// Control points let the Expression Engine deform features per emotion.

export interface CartoonPalette {
  skin: string;
  skinShadow: string;
  cheek: string;
  hair: string;
  hairShadow: string;
  outline: string;
  eyeWhite: string;
  iris: string;
  pupil: string;
  highlight: string;
  brow: string;
  mouth: string;
  mouthInner: string;
  tongue: string;
  tooth: string;
}

export const defaultPalette: CartoonPalette = {
  skin: "#ffe1c8",
  skinShadow: "#f4c8a3",
  cheek: "#ff9aa3",
  hair: "#3a2a1f",
  hairShadow: "#23170f",
  outline: "#2b1a14",
  eyeWhite: "#ffffff",
  iris: "#5a8acb",
  pupil: "#0e1633",
  highlight: "#ffffff",
  brow: "#3a2a1f",
  mouth: "#7a2b30",
  mouthInner: "#3b1014",
  tongue: "#e26572",
  tooth: "#fff7e8",
};

// Emotion → feature offsets (what the renderer reads each frame).
export interface ExpressionParams {
  // Eyes
  eyeOpen: number; // 0 closed → 1 normal → 1.4 wide
  eyeArc: number; // upward arc (smiling eyes), -0.2..0.6
  pupilDx: number; // -1..1 (gaze offset)
  pupilDy: number;
  pupilScale: number;
  // Eyebrows
  browLift: number; // -1 (frown) .. 1 (raised)
  browTilt: number; // -1 (sad/inner-up) .. 1 (angry/inner-down)
  // Mouth
  mouthCurve: number; // -1 (frown) .. 1 (smile)
  mouthOpen: number; // 0..1 vertical opening
  mouthWidth: number; // 0.7..1.2
  showTeeth: boolean;
  // Cheek/blush
  blush: number; // 0..1
  // Head subtle tilt (radians) — drives motion engine bobbing
  headTilt: number;
  headBobY: number; // px
}

export const baseExpression: ExpressionParams = {
  eyeOpen: 1,
  eyeArc: 0,
  pupilDx: 0,
  pupilDy: 0,
  pupilScale: 1,
  browLift: 0,
  browTilt: 0,
  mouthCurve: 0.05,
  mouthOpen: 0,
  mouthWidth: 1,
  showTeeth: false,
  blush: 0,
  headTilt: 0,
  headBobY: 0,
};

// Emotion presets — Expression Engine blends current → target.
export const emotionPresets: Record<Emotion, Partial<ExpressionParams>> = {
  neutral: {},
  happy: {
    eyeArc: 0.6,
    eyeOpen: 0.7,
    browLift: 0.25,
    mouthCurve: 1,
    mouthWidth: 1.08,
    mouthOpen: 0.05,
    showTeeth: true,
    blush: 0.4,
  },
  sad: {
    eyeOpen: 0.7,
    browLift: -0.2,
    browTilt: -0.7,
    mouthCurve: -0.7,
    mouthWidth: 0.9,
    pupilDy: 0.25,
  },
  angry: {
    eyeOpen: 0.85,
    browLift: -0.6,
    browTilt: 0.9,
    mouthCurve: -0.4,
    mouthWidth: 0.95,
    mouthOpen: 0.1,
    showTeeth: true,
  },
  thinking: {
    eyeOpen: 0.9,
    browLift: 0.2,
    browTilt: -0.3,
    mouthCurve: -0.1,
    mouthWidth: 0.85,
    pupilDx: -0.4,
    pupilDy: -0.4,
  },
  surprised: {
    eyeOpen: 1.35,
    browLift: 0.9,
    mouthCurve: 0,
    mouthOpen: 0.7,
    mouthWidth: 0.85,
    pupilScale: 0.85,
  },
  shy: {
    eyeArc: 0.35,
    eyeOpen: 0.7,
    browLift: 0.1,
    mouthCurve: 0.3,
    mouthWidth: 0.8,
    blush: 0.85,
    pupilDy: 0.15,
    headTilt: -0.08,
  },
};

// Geometry — anchor points (template-space ratios on the canvas).
export const layout = {
  headCenter: { x: 0.5, y: 0.55 },
  headRx: 0.22,
  headRy: 0.27,
  hairCrown: { x: 0.5, y: 0.32 },
  earL: { x: 0.275, y: 0.56 },
  earR: { x: 0.725, y: 0.56 },
  eyeL: { x: 0.42, y: 0.55 },
  eyeR: { x: 0.58, y: 0.55 },
  eyeRx: 0.04,
  eyeRy: 0.055,
  pupilR: 0.018,
  browL: { x: 0.42, y: 0.475 },
  browR: { x: 0.58, y: 0.475 },
  browLen: 0.07,
  noseTip: { x: 0.5, y: 0.6 },
  mouth: { x: 0.5, y: 0.685 },
  mouthW: 0.1,
  cheekL: { x: 0.395, y: 0.64 },
  cheekR: { x: 0.605, y: 0.64 },
  cheekR2: 0.024,
};
