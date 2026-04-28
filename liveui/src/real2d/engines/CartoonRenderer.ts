// Cartoon renderer (Canvas 2D). Draws a programmatic cartoon face from
// control points. Same ExpressionParams pipeline as PhotoRenderer so the
// runtime can hot-swap renderers without changing animation logic.

import {
  baseExpression,
  defaultPalette,
  layout,
  type CartoonPalette,
  type ExpressionParams,
} from "../templates/cartoon.js";
import { clamp, lerp } from "../utils/clock.js";
import type { Renderer } from "./Renderer.js";

export class CartoonRenderer implements Renderer {
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private dpr: number;
  private palette: CartoonPalette;

  constructor(canvas: HTMLCanvasElement, palette = defaultPalette) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    this.width = canvas.width;
    this.height = canvas.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.palette = palette;
  }

  resize(canvas: HTMLCanvasElement): void {
    this.width = canvas.width;
    this.height = canvas.height;
  }

  draw(params: ExpressionParams = baseExpression): void {
    const c = this.ctx;
    c.save();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const w = this.width / this.dpr;
    const h = this.height / this.dpr;
    c.clearRect(0, 0, w, h);

    // Apply head tilt + bob around head center.
    const cx = layout.headCenter.x * w;
    const cy = layout.headCenter.y * h + params.headBobY;
    c.translate(cx, cy);
    c.rotate(params.headTilt);
    c.translate(-cx, -cy);

    this.drawHair(c, w, h, "back");
    this.drawNeck(c, w, h);
    this.drawHead(c, w, h);
    this.drawHair(c, w, h, "front");
    this.drawCheeks(c, w, h, params);
    this.drawEyes(c, w, h, params);
    this.drawBrows(c, w, h, params);
    this.drawNose(c, w, h);
    this.drawMouth(c, w, h, params);

    c.restore();
  }

  private drawHead(c: CanvasRenderingContext2D, w: number, h: number): void {
    const { skin, skinShadow, outline } = this.palette;
    const cx = layout.headCenter.x * w;
    const cy = layout.headCenter.y * h;
    const rx = layout.headRx * w;
    const ry = layout.headRy * h;

    // ears
    c.fillStyle = skin;
    c.strokeStyle = outline;
    c.lineWidth = 2;
    c.beginPath();
    c.ellipse(layout.earL.x * w, layout.earL.y * h, rx * 0.22, ry * 0.22, 0, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.beginPath();
    c.ellipse(layout.earR.x * w, layout.earR.y * h, rx * 0.22, ry * 0.22, 0, 0, Math.PI * 2);
    c.fill();
    c.stroke();

    // face shadow
    c.fillStyle = skinShadow;
    c.beginPath();
    c.ellipse(cx, cy + ry * 0.05, rx, ry, 0, 0, Math.PI * 2);
    c.fill();

    // face
    c.fillStyle = skin;
    c.beginPath();
    c.ellipse(cx, cy, rx * 0.97, ry * 0.97, 0, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = outline;
    c.stroke();
  }

  private drawNeck(c: CanvasRenderingContext2D, w: number, h: number): void {
    const { skin, skinShadow, outline } = this.palette;
    const cx = layout.headCenter.x * w;
    const cy = layout.headCenter.y * h;
    const rx = layout.headRx * w;
    const ry = layout.headRy * h;
    c.fillStyle = skinShadow;
    c.beginPath();
    c.moveTo(cx - rx * 0.35, cy + ry * 0.85);
    c.lineTo(cx + rx * 0.35, cy + ry * 0.85);
    c.lineTo(cx + rx * 0.45, cy + ry * 1.4);
    c.lineTo(cx - rx * 0.45, cy + ry * 1.4);
    c.closePath();
    c.fill();
    c.fillStyle = skin;
    c.beginPath();
    c.moveTo(cx - rx * 0.32, cy + ry * 0.85);
    c.lineTo(cx + rx * 0.32, cy + ry * 0.85);
    c.lineTo(cx + rx * 0.4, cy + ry * 1.3);
    c.lineTo(cx - rx * 0.4, cy + ry * 1.3);
    c.closePath();
    c.fill();
    c.strokeStyle = outline;
    c.lineWidth = 1.5;
    c.stroke();
  }

  private drawHair(
    c: CanvasRenderingContext2D,
    w: number,
    h: number,
    layer: "front" | "back",
  ): void {
    const { hair, hairShadow, outline } = this.palette;
    const cx = layout.headCenter.x * w;
    const cy = layout.headCenter.y * h;
    const rx = layout.headRx * w;
    const ry = layout.headRy * h;

    if (layer === "back") {
      c.fillStyle = hairShadow;
      c.beginPath();
      c.ellipse(cx, cy - ry * 0.05, rx * 1.18, ry * 1.18, 0, Math.PI, 0);
      c.lineTo(cx + rx * 1.18, cy + ry * 0.6);
      c.lineTo(cx - rx * 1.18, cy + ry * 0.6);
      c.closePath();
      c.fill();
      return;
    }

    // front bangs
    c.fillStyle = hair;
    c.beginPath();
    c.moveTo(cx - rx * 1.05, cy - ry * 0.15);
    c.bezierCurveTo(
      cx - rx * 1.1,
      cy - ry * 1.0,
      cx + rx * 1.1,
      cy - ry * 1.05,
      cx + rx * 1.05,
      cy - ry * 0.1,
    );
    c.bezierCurveTo(
      cx + rx * 0.6,
      cy - ry * 0.55,
      cx + rx * 0.1,
      cy - ry * 0.4,
      cx - rx * 0.05,
      cy - ry * 0.6,
    );
    c.bezierCurveTo(
      cx - rx * 0.2,
      cy - ry * 0.4,
      cx - rx * 0.7,
      cy - ry * 0.55,
      cx - rx * 1.05,
      cy - ry * 0.15,
    );
    c.closePath();
    c.fill();
    c.strokeStyle = outline;
    c.lineWidth = 1.5;
    c.stroke();
  }

  private drawCheeks(
    c: CanvasRenderingContext2D,
    w: number,
    h: number,
    p: ExpressionParams,
  ): void {
    if (p.blush <= 0) return;
    c.save();
    c.fillStyle = this.palette.cheek;
    c.globalAlpha = clamp(p.blush, 0, 1) * 0.7;
    c.beginPath();
    c.ellipse(layout.cheekL.x * w, layout.cheekL.y * h, layout.cheekR2 * w, layout.cheekR2 * h * 1.4, 0, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.ellipse(layout.cheekR.x * w, layout.cheekR.y * h, layout.cheekR2 * w, layout.cheekR2 * h * 1.4, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  private drawEyes(
    c: CanvasRenderingContext2D,
    w: number,
    h: number,
    p: ExpressionParams,
  ): void {
    const { outline, eyeWhite, iris, pupil, highlight } = this.palette;
    const open = clamp(p.eyeOpen, 0, 1.6);
    const arc = clamp(p.eyeArc, -0.4, 0.8);
    const rx = layout.eyeRx * w;
    const ryBase = layout.eyeRy * h;
    const ry = ryBase * open;

    for (const eye of [layout.eyeL, layout.eyeR]) {
      const ex = eye.x * w;
      const ey = eye.y * h;

      // eye white (or arc when smiling/closed)
      if (open <= 0.08 || arc > 0.4) {
        // closed/smiling arc — draw a curved line
        c.strokeStyle = outline;
        c.lineWidth = 2.2;
        c.lineCap = "round";
        c.beginPath();
        const arcLift = arc * ryBase * 0.9;
        c.moveTo(ex - rx, ey + arcLift * 0.2);
        c.quadraticCurveTo(ex, ey - arcLift, ex + rx, ey + arcLift * 0.2);
        c.stroke();
        continue;
      }

      c.fillStyle = eyeWhite;
      c.beginPath();
      c.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = outline;
      c.lineWidth = 1.6;
      c.stroke();

      // iris
      const px = ex + p.pupilDx * rx * 0.45;
      const py = ey + p.pupilDy * ry * 0.45;
      const irisR = (layout.pupilR * w * 1.6) * p.pupilScale;
      c.save();
      c.beginPath();
      c.ellipse(ex, ey, rx - 1, ry - 1, 0, 0, Math.PI * 2);
      c.clip();
      c.fillStyle = iris;
      c.beginPath();
      c.arc(px, py, irisR, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = pupil;
      c.beginPath();
      c.arc(px, py, irisR * 0.55, 0, Math.PI * 2);
      c.fill();
      // highlight
      c.fillStyle = highlight;
      c.beginPath();
      c.arc(px - irisR * 0.3, py - irisR * 0.35, irisR * 0.3, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  private drawBrows(
    c: CanvasRenderingContext2D,
    w: number,
    h: number,
    p: ExpressionParams,
  ): void {
    const { brow } = this.palette;
    const lift = p.browLift * (layout.eyeRy * h * 0.8);
    const tilt = p.browTilt; // -1..1
    const len = layout.browLen * w;
    c.strokeStyle = brow;
    c.lineWidth = 4;
    c.lineCap = "round";

    // left brow — inner end is on the right
    {
      const ax = layout.browL.x * w - len / 2;
      const bx = layout.browL.x * w + len / 2;
      const innerY = layout.browL.y * h - lift + tilt * len * 0.35;
      const outerY = layout.browL.y * h - lift - tilt * len * 0.35;
      c.beginPath();
      c.moveTo(ax, outerY);
      c.quadraticCurveTo((ax + bx) / 2, (innerY + outerY) / 2 - 2, bx, innerY);
      c.stroke();
    }
    // right brow — inner end is on the left
    {
      const ax = layout.browR.x * w - len / 2;
      const bx = layout.browR.x * w + len / 2;
      const innerY = layout.browR.y * h - lift + tilt * len * 0.35;
      const outerY = layout.browR.y * h - lift - tilt * len * 0.35;
      c.beginPath();
      c.moveTo(ax, innerY);
      c.quadraticCurveTo((ax + bx) / 2, (innerY + outerY) / 2 - 2, bx, outerY);
      c.stroke();
    }
  }

  private drawNose(c: CanvasRenderingContext2D, w: number, h: number): void {
    const { outline } = this.palette;
    const x = layout.noseTip.x * w;
    const y = layout.noseTip.y * h;
    c.strokeStyle = outline;
    c.lineWidth = 1.6;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(x - 4, y);
    c.quadraticCurveTo(x, y + 6, x + 4, y);
    c.stroke();
  }

  private drawMouth(
    c: CanvasRenderingContext2D,
    w: number,
    h: number,
    p: ExpressionParams,
  ): void {
    const { outline, mouth, mouthInner, tongue, tooth } = this.palette;
    const cx = layout.mouth.x * w;
    const cy = layout.mouth.y * h;
    const mw = layout.mouthW * w * clamp(p.mouthWidth, 0.5, 1.4);
    const curve = clamp(p.mouthCurve, -1, 1);
    const open = clamp(p.mouthOpen, 0, 1);

    const left = { x: cx - mw / 2, y: cy };
    const right = { x: cx + mw / 2, y: cy };
    // Vertical control offset for smile/frown.
    const curveOffset = curve * mw * 0.35;
    const topMidY = cy - curveOffset * 0.2;
    const bottomMidY = cy + lerp(0, mw * 0.8, open) - curveOffset;

    // Outer mouth shape
    c.fillStyle = open > 0.05 ? mouthInner : mouth;
    c.beginPath();
    c.moveTo(left.x, left.y);
    c.quadraticCurveTo(cx, topMidY, right.x, right.y);
    c.quadraticCurveTo(cx, bottomMidY, left.x, left.y);
    c.closePath();
    c.fill();
    c.strokeStyle = outline;
    c.lineWidth = 2;
    c.stroke();

    if (open > 0.18) {
      // tongue
      c.save();
      c.beginPath();
      c.moveTo(left.x + mw * 0.1, cy + (bottomMidY - cy) * 0.55);
      c.quadraticCurveTo(cx, bottomMidY * 0.95, right.x - mw * 0.1, cy + (bottomMidY - cy) * 0.55);
      c.quadraticCurveTo(cx, bottomMidY, left.x + mw * 0.1, cy + (bottomMidY - cy) * 0.55);
      c.closePath();
      c.clip();
      c.fillStyle = tongue;
      c.fillRect(left.x, cy, mw, (bottomMidY - cy) + 4);
      c.restore();
    }

    if (p.showTeeth && open > 0.05) {
      c.fillStyle = tooth;
      const teethY = topMidY + 1;
      const teethH = Math.max(2, (bottomMidY - topMidY) * 0.22);
      c.beginPath();
      c.moveTo(left.x + 3, teethY);
      c.lineTo(right.x - 3, teethY);
      c.lineTo(right.x - 5, teethY + teethH);
      c.lineTo(left.x + 5, teethY + teethH);
      c.closePath();
      c.fill();
    }
  }
}
