// SPEC §7 — AvatarState standard
export type Emotion =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "thinking"
  | "surprised"
  | "shy";

export type Gaze =
  | "center"
  | "left"
  | "right"
  | "up"
  | "down"
  | "close";

export type Motion = "idle" | "nod" | "shake" | "bounce";

export interface AvatarState {
  emotion?: Emotion;
  speaking?: boolean;
  gaze?: Gaze;
  intensity?: number; // 0..1
  motion?: Motion;
}

// SPEC §4.1
export interface Point {
  x: number;
  y: number;
}

export interface IdentityProfile {
  controlPoints: Point[];
  faceFeatures: Record<string, number>;
}

// SPEC §6 — WebSocket message types
export type WsMessage =
  | ({ type: "state" } & AvatarState)
  | { type: "expression"; name: Emotion; duration?: number }
  | { type: "scene"; background?: string; mood?: string }
  | { type: "effect"; name: EffectName; duration?: number }
  | { type: "prop"; name: PropName; position?: PropPosition; duration?: number };

export type EffectName = "sparkle" | "shake" | "flash" | "bounce";
export type PropName = "question_mark" | "heart" | "sweat" | "exclamation" | "bubble";
export type PropPosition = "above_head" | "left" | "right" | "center";

// SPEC §12
export type RuntimeError =
  | "WEBSOCKET_DISCONNECTED"
  | "TEMPLATE_LOAD_FAILED"
  | "LANDMARK_FAILED"
  | "RENDER_FAILED";

// Runtime config
export interface AvatarRuntimeConfig {
  container: string | HTMLElement;
  template?: string;
  photo?: string;
  websocketUrl?: string;
  width?: number;
  height?: number;
  autoConnect?: boolean;
  onError?: (e: RuntimeError, detail?: unknown) => void;
}

// Scene
export type SceneMood = "calm" | "warm" | "cool" | "dramatic" | "neutral";
export type SceneBackground =
  | "day"
  | "night"
  | "sunset"
  | "indoor"
  | "studio"
  | "transparent";

export interface SceneState {
  background: SceneBackground;
  mood: SceneMood;
}
