// Shared mesh-warp drawing helper. Used by both PhotoRenderer (single profile,
// fit-to-canvas) and SpriteRenderer (one warp per active sprite, face-aligned
// across multiple profiles). The fit transform converts profile image-space
// coordinates → canvas (CSS-px) coordinates.

import { deformMesh } from "../identity/LandmarkDeformer.js";
import type { IdentityProfile } from "../identity/IdentityEngine.js";
import type { ExpressionParams } from "../templates/cartoon.js";
import type { Point } from "../types/index.js";

export interface FitTransform {
  scale: number;
  ox: number;
  oy: number;
  // Optional separate horizontal scale. When set, x coords use scaleX
  // and y coords use scale — used for phoneme overlays where we want
  // a small horizontal stretch without scaling the overlay vertically.
  scaleX?: number;
}

export function drawWarpedProfile(
  ctx: CanvasRenderingContext2D,
  profile: IdentityProfile,
  params: ExpressionParams,
  fit: FitTransform,
): void {
  const verts = deformMesh(profile, params);
  const tri = profile.triangles;
  const src = profile.meshVerts;
  const bitmap = profile.imageBitmap;
  const sx = fit.scaleX ?? fit.scale;
  const sy = fit.scale;
  const ox = fit.ox;
  const oy = fit.oy;

  for (let t = 0; t < tri.length; t += 3) {
    const i0 = tri[t];
    const i1 = tri[t + 1];
    const i2 = tri[t + 2];

    const sa = src[i0];
    const sb = src[i1];
    const sc = src[i2];
    const va = verts[i0];
    const vb = verts[i1];
    const vc = verts[i2];

    const srcArea =
      (sb.x - sa.x) * (sc.y - sa.y) - (sb.y - sa.y) * (sc.x - sa.x);
    if (Math.abs(srcArea) < 0.5) continue;

    const da = { x: va.x * sx + ox, y: va.y * sy + oy };
    const db = { x: vb.x * sx + ox, y: vb.y * sy + oy };
    const dc = { x: vc.x * sx + ox, y: vc.y * sy + oy };

    const m = affine(sa, sb, sc, da, db, dc);
    if (!m) continue;

    ctx.save();
    const center = {
      x: (da.x + db.x + dc.x) / 3,
      y: (da.y + db.y + dc.y) / 3,
    };
    const inf = 0.5;
    ctx.beginPath();
    ctx.moveTo(...inflate(da, center, inf));
    ctx.lineTo(...inflate(db, center, inf));
    ctx.lineTo(...inflate(dc, center, inf));
    ctx.closePath();
    ctx.clip();
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();
  }
}

interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

function affine(
  sa: Point,
  sb: Point,
  sc: Point,
  da: Point,
  db: Point,
  dc: Point,
): Affine | null {
  const e1x = sb.x - sa.x;
  const e1y = sb.y - sa.y;
  const e2x = sc.x - sa.x;
  const e2y = sc.y - sa.y;
  const det = e1x * e2y - e2x * e1y;
  if (Math.abs(det) < 1e-6) return null;
  const inv = 1 / det;

  const ed1x = db.x - da.x;
  const ed1y = db.y - da.y;
  const ed2x = dc.x - da.x;
  const ed2y = dc.y - da.y;

  const a = (e2y * ed1x - e1y * ed2x) * inv;
  const c = (-e2x * ed1x + e1x * ed2x) * inv;
  const b = (e2y * ed1y - e1y * ed2y) * inv;
  const d = (-e2x * ed1y + e1x * ed2y) * inv;
  const e = da.x - a * sa.x - c * sa.y;
  const f = da.y - b * sa.x - d * sa.y;
  return { a, b, c, d, e, f };
}

function inflate(p: Point, center: Point, by: number): [number, number] {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  return [p.x + (dx / len) * by, p.y + (dy / len) * by];
}
