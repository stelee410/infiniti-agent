/** 规格：15×15 人脸网格（与 SPEC 一致） */
export const MESH_SEG = 14
export const MESH_DIM = MESH_SEG + 1

export type Vec2 = { x: number; y: number }

export type MeshVertex = Vec2 & {
  /** 0..1，用于 Parallax：鼻附近 1.0，边缘 ~0.2 */
  parallaxWeight: number
  /** 归一化 UV，便于贴图采样 */
  u: number
  v: number
}

export type MeshTopology = {
  vertices: MeshVertex[]
  /** 每三元组为一个三角形，索引指向 vertices */
  indices: number[]
}

/**
 * 构建拓扑与 Parallax 权重场。
 * @param anchorUv 鼻子/面中心在贴图上的归一化位置（默认面中略偏上）
 * @param edgeWeight 边缘顶点最小权重（SPEC：0.2）
 * @param centerWeight 锚点权重（SPEC：1.0）
 */
export function buildFaceMeshGrid(opts?: {
  anchorUv?: Vec2
  edgeWeight?: number
  centerWeight?: number
}): MeshTopology {
  const ax = opts?.anchorUv?.x ?? 0.5
  const ay = opts?.anchorUv?.y ?? 0.42
  const wMin = opts?.edgeWeight ?? 0.2
  const wMax = opts?.centerWeight ?? 1
  const maxR = Math.hypot(Math.max(ax, 1 - ax), Math.max(ay, 1 - ay)) || 1

  const vertices: MeshVertex[] = []
  for (let j = 0; j < MESH_DIM; j++) {
    const v = j / MESH_SEG
    for (let i = 0; i < MESH_DIM; i++) {
      const u = i / MESH_SEG
      const d = Math.hypot(u - ax, v - ay) / maxR
      const t = Math.min(1, Math.max(0, d))
      const parallaxWeight = wMin + (wMax - wMin) * (1 - t)
      vertices.push({ x: u, y: v, u, v, parallaxWeight })
    }
  }

  const indices: number[] = []
  for (let j = 0; j < MESH_SEG; j++) {
    for (let i = 0; i < MESH_SEG; i++) {
      const i00 = j * MESH_DIM + i
      const i10 = i00 + 1
      const i01 = i00 + MESH_DIM
      const i11 = i01 + 1
      indices.push(i00, i10, i01, i10, i11, i01)
    }
  }

  return { vertices, indices }
}

/**
 * 将顶点基准位置与 Parallax 位移叠加。
 * 权重在鼻/面心高、边缘低，位移模长按权重缩放，使中心带动大于外轮廓（SPEC）。
 */
export function applyParallaxOffsets(
  verts: readonly MeshVertex[],
  rotationX: number,
  amp: number,
): Vec2[] {
  return verts.map((p) => {
    const w = p.parallaxWeight
    const dx = rotationX * amp * w
    const dy = rotationX * amp * w * 0.12 * (p.y - 0.5) * 2
    return { x: p.x + dx, y: p.y + dy }
  })
}
