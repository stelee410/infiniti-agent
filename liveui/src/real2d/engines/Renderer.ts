import type { ExpressionParams } from "../templates/cartoon.js";

// Common interface for any avatar renderer (cartoon, photo-warp, future 3D...).
// Holds the canvas and translates ExpressionParams → pixels.
export interface Renderer {
  draw(params: ExpressionParams): void;
  resize?(canvas: HTMLCanvasElement): void;
  destroy?(): void;
}
