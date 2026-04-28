import type { ExpressionParams } from "../templates/cartoon.js";
import type { IdentityProfile } from "../identity/IdentityEngine.js";
import type { Renderer } from "./Renderer.js";
import { drawWarpedProfile, type FitTransform } from "./warp.js";

// SPEC §4.3 — Mesh Engine: Delaunay triangulation + per-triangle affine warp.
// Single-photo mode. Fits the image to canvas preserving aspect, then runs
// the shared warp helper each frame against the current ExpressionParams.

export class PhotoRenderer implements Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvasW: number;
  private canvasH: number;
  private dpr: number;
  private fit: FitTransform = { scale: 1, ox: 0, oy: 0 };

  constructor(canvas: HTMLCanvasElement, private profile: IdentityProfile) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    this.canvasW = canvas.width;
    this.canvasH = canvas.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.computeFit();
  }

  resize(canvas: HTMLCanvasElement): void {
    this.canvasW = canvas.width;
    this.canvasH = canvas.height;
    this.computeFit();
  }

  destroy(): void {
    try {
      this.profile.imageBitmap.close();
    } catch {
      /* older browsers */
    }
  }

  private computeFit(): void {
    const cssW = this.canvasW / this.dpr;
    const cssH = this.canvasH / this.dpr;
    const scale = Math.min(cssW / this.profile.imageW, cssH / this.profile.imageH);
    this.fit = {
      scale,
      ox: (cssW - this.profile.imageW * scale) / 2,
      oy: (cssH - this.profile.imageH * scale) / 2,
    };
  }

  draw(params: ExpressionParams): void {
    const c = this.ctx;
    const w = this.canvasW / this.dpr;
    const h = this.canvasH / this.dpr;
    c.save();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    drawWarpedProfile(c, this.profile, params, this.fit);
    c.restore();
  }
}
