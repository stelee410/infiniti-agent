import {
  baseExpression,
  emotionPresets,
  type ExpressionParams,
} from "../templates/cartoon.js";
import type { AvatarState, Emotion, Gaze } from "../types/index.js";
import { clamp, lerp } from "../utils/clock.js";

interface GazeEffect {
  dx: number;
  dy: number;
  // If set, overrides eyeOpen. Used by `close` to shut the eyes.
  eyeOpen?: number;
}

const gazeOffsets: Record<Gaze, GazeEffect> = {
  center: { dx: 0, dy: 0 },
  left: { dx: -0.9, dy: 0 },
  right: { dx: 0.9, dy: 0 },
  up: { dx: 0, dy: -0.85 },
  down: { dx: 0, dy: 0.85 },
  // `close` doesn't shift pupils — it shuts the eyes. eyeOpen=0 lets the
  // sprite renderer's blink overlay show the eyes_closed sprite, and the
  // mesh deformer applies the same eye-squash math the auto-blink uses.
  close: { dx: 0, dy: 0, eyeOpen: 0 },
};

// Builds the *target* expression params from a logical AvatarState.
// SPEC §9 priority: speaking > emotion > gaze > idle. We bake all three
// channels into the params; the renderer reads only the final ExpressionParams.
export function targetFromState(state: AvatarState): ExpressionParams {
  const emotion: Emotion = state.emotion ?? "neutral";
  const intensity = clamp(state.intensity ?? 1, 0, 1.4);

  const params: ExpressionParams = { ...baseExpression };
  const preset = emotionPresets[emotion] ?? {};
  for (const k of Object.keys(preset) as (keyof ExpressionParams)[]) {
    const baseVal = baseExpression[k];
    const targetVal = (preset[k] as ExpressionParams[typeof k]);
    if (typeof baseVal === "number" && typeof targetVal === "number") {
      (params[k] as number) = lerp(baseVal as number, targetVal as number, intensity);
    } else if (typeof targetVal === "boolean") {
      (params[k] as boolean) = targetVal;
    }
  }

  // Gaze on top of emotion-driven pupils.
  const g = gazeOffsets[state.gaze ?? "center"];
  params.pupilDx = clamp(params.pupilDx + g.dx, -1, 1);
  params.pupilDy = clamp(params.pupilDy + g.dy, -1, 1);
  if (g.eyeOpen !== undefined) {
    params.eyeOpen = g.eyeOpen;
  }

  return params;
}

// Smoothly interpolates current → target params each tick.
// dt in ms; tau ≈ time-constant in ms (smaller = snappier).
export function easeParams(
  cur: ExpressionParams,
  target: ExpressionParams,
  dt: number,
  tau = 90,
): void {
  const k = 1 - Math.exp(-dt / tau);
  for (const key of Object.keys(cur) as (keyof ExpressionParams)[]) {
    const a = cur[key];
    const b = target[key];
    if (typeof a === "number" && typeof b === "number") {
      (cur[key] as number) = a + (b - a) * k;
    } else if (typeof b === "boolean") {
      (cur[key] as boolean) = b;
    }
  }
}
