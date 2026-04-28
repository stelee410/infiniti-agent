// Minimal UI layer — speech bubble + status text. SPEC §4.9.
export class UILayer {
  private bubble: HTMLDivElement;
  private hideTimer: number | null = null;

  constructor(private root: HTMLDivElement) {
    this.bubble = document.createElement("div");
    this.bubble.className = "avr-bubble";
    this.root.appendChild(this.bubble);
  }

  say(text: string, duration = 2400): void {
    this.bubble.textContent = text;
    this.bubble.classList.add("visible");
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.bubble.classList.remove("visible");
    }, duration);
  }

  clear(): void {
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    this.bubble.classList.remove("visible");
  }
}
