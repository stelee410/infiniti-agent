import type { SceneBackground, SceneMood, SceneState } from "../types/index.js";

const BG_CLASSES: SceneBackground[] = [
  "day",
  "night",
  "sunset",
  "indoor",
  "studio",
  "transparent",
];
const MOOD_CLASSES: SceneMood[] = [
  "calm",
  "warm",
  "cool",
  "dramatic",
  "neutral",
];

export class SceneEngine {
  private state: SceneState = { background: "day", mood: "neutral" };
  constructor(private el: HTMLDivElement) {
    this.apply();
  }

  set(partial: Partial<SceneState>): void {
    this.state = { ...this.state, ...partial };
    this.apply();
  }

  get(): SceneState {
    return { ...this.state };
  }

  private apply(): void {
    const cl = this.el.classList;
    for (const b of BG_CLASSES) cl.remove(`bg-${b}`);
    for (const m of MOOD_CLASSES) cl.remove(`mood-${m}`);
    cl.add(`bg-${this.state.background}`);
    cl.add(`mood-${this.state.mood}`);
  }
}
