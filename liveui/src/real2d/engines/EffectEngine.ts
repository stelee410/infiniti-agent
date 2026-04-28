import type { EffectName } from "../types/index.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export class EffectEngine {
  private flashEl: HTMLDivElement | null = null;

  constructor(
    private root: HTMLElement,
    private svg: SVGSVGElement,
  ) {}

  fire(name: EffectName, duration = 800): void {
    switch (name) {
      case "sparkle":
        return this.sparkle(duration);
      case "shake":
        return this.shake();
      case "flash":
        return this.flash();
      case "bounce":
        return this.bounceRoot();
    }
  }

  private sparkle(duration: number): void {
    // Spawn N sparkles around the head area; auto-cleanup.
    const w = this.svg.viewBox.baseVal.width || 480;
    const h = this.svg.viewBox.baseVal.height || 480;
    const count = 6;
    for (let i = 0; i < count; i++) {
      const star = document.createElementNS(SVG_NS, "path");
      star.setAttribute("class", "avr-sparkle");
      const cx = w * (0.3 + Math.random() * 0.4);
      const cy = h * (0.2 + Math.random() * 0.4);
      const size = 6 + Math.random() * 8;
      star.setAttribute("d", starPath(cx, cy, size));
      star.style.animationDelay = `${Math.random() * 200}ms`;
      star.style.animationDuration = `${duration}ms`;
      this.svg.appendChild(star);
      setTimeout(() => star.remove(), duration + 200);
    }
  }

  private shake(): void {
    this.root.classList.remove("shake");
    void this.root.offsetWidth; // restart animation
    this.root.classList.add("shake");
    setTimeout(() => this.root.classList.remove("shake"), 320);
  }

  private flash(): void {
    if (!this.flashEl) {
      this.flashEl = document.createElement("div");
      this.flashEl.className = "avr-flash";
      this.root.appendChild(this.flashEl);
    }
    this.flashEl.classList.remove("fire");
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add("fire");
  }

  private bounceRoot(): void {
    this.root.animate(
      [
        { transform: "translateY(0)" },
        { transform: "translateY(-14px)", offset: 0.4 },
        { transform: "translateY(0)" },
      ],
      { duration: 480, easing: "cubic-bezier(.34,1.56,.64,1)" },
    );
  }
}

function starPath(cx: number, cy: number, r: number): string {
  // 4-point sparkle (diamond cross)
  return [
    `M ${cx} ${cy - r}`,
    `Q ${cx + r * 0.25} ${cy} ${cx + r} ${cy}`,
    `Q ${cx + r * 0.25} ${cy} ${cx} ${cy + r}`,
    `Q ${cx - r * 0.25} ${cy} ${cx - r} ${cy}`,
    `Q ${cx - r * 0.25} ${cy} ${cx} ${cy - r} Z`,
  ].join(" ");
}
