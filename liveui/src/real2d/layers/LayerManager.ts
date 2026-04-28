// SPEC §3 — multi-layer renderer container
// Layer order (bottom → top): Scene → Avatar → Prop → Effect → UI
// Per SPEC §8: avatar=Canvas, scene=HTML/CSS, effects=SVG/CSS, UI=DOM.

export interface LayerSet {
  root: HTMLElement;
  scene: HTMLDivElement;
  avatar: HTMLCanvasElement;
  prop: HTMLDivElement;
  effect: SVGSVGElement;
  ui: HTMLDivElement;
  width: number;
  height: number;
  dpr: number;
}

export function buildLayers(
  container: HTMLElement,
  width: number,
  height: number,
): LayerSet {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  container.classList.add("avr-root");
  container.style.position = container.style.position || "relative";
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  container.style.overflow = "hidden";

  const scene = makeDiv("avr-layer avr-scene");
  const avatar = document.createElement("canvas");
  avatar.className = "avr-layer avr-avatar";
  avatar.width = Math.round(width * dpr);
  avatar.height = Math.round(height * dpr);
  avatar.style.width = `${width}px`;
  avatar.style.height = `${height}px`;
  const prop = makeDiv("avr-layer avr-prop");
  const effect = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  effect.setAttribute("class", "avr-layer avr-effect");
  effect.setAttribute("viewBox", `0 0 ${width} ${height}`);
  effect.setAttribute("width", String(width));
  effect.setAttribute("height", String(height));
  const ui = makeDiv("avr-layer avr-ui");

  for (const el of [scene, avatar, prop, effect, ui]) {
    (el as HTMLElement).style.position = "absolute";
    (el as HTMLElement).style.left = "0";
    (el as HTMLElement).style.top = "0";
    (el as HTMLElement).style.width = "100%";
    (el as HTMLElement).style.height = "100%";
  }
  // pointer events: scene/avatar/prop/effect ignore, UI catches.
  scene.style.pointerEvents = "none";
  avatar.style.pointerEvents = "none";
  prop.style.pointerEvents = "none";
  (effect as unknown as HTMLElement).style.pointerEvents = "none";
  ui.style.pointerEvents = "auto";

  container.append(scene, avatar, prop, effect, ui);

  return { root: container, scene, avatar, prop, effect, ui, width, height, dpr };
}

function makeDiv(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

export function teardownLayers(layers: LayerSet): void {
  layers.scene.remove();
  layers.avatar.remove();
  layers.prop.remove();
  layers.effect.remove();
  layers.ui.remove();
  layers.root.classList.remove("avr-root");
}
