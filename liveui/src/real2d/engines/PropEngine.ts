import type { PropName, PropPosition } from "../types/index.js";

const PROP_GLYPHS: Record<PropName, string> = {
  question_mark: "❓",
  heart: "❤️",
  sweat: "💧",
  exclamation: "❗",
  bubble: "💭",
};

const POSITIONS: Record<PropPosition, { x: number; y: number }> = {
  above_head: { x: 0.62, y: 0.18 },
  left: { x: 0.2, y: 0.5 },
  right: { x: 0.8, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
};

export class PropEngine {
  private slots = new Map<string, HTMLElement>();
  constructor(private el: HTMLDivElement) {}

  show(name: PropName, position: PropPosition = "above_head", duration = 1600): string {
    const id = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const node = document.createElement("div");
    node.className = "avr-prop-item bob";
    const pos = POSITIONS[position];
    node.style.left = `${pos.x * 100}%`;
    node.style.top = `${pos.y * 100}%`;
    node.style.fontSize = "44px";
    node.style.lineHeight = "1";
    node.style.transformOrigin = "center";
    node.textContent = PROP_GLYPHS[name];
    this.el.appendChild(node);
    this.slots.set(id, node);

    if (duration > 0) {
      setTimeout(() => this.hide(id), duration);
    }
    return id;
  }

  hide(id: string): void {
    const node = this.slots.get(id);
    if (!node) return;
    node.classList.remove("bob");
    node.classList.add("fade-out");
    this.slots.delete(id);
    setTimeout(() => node.remove(), 240);
  }

  clear(): void {
    for (const id of [...this.slots.keys()]) this.hide(id);
  }
}
