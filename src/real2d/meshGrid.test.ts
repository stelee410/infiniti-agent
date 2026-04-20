import { describe, expect, it } from 'vitest'
import { MESH_DIM, MESH_SEG, buildFaceMeshGrid, applyParallaxOffsets } from './meshGrid.js'

describe('buildFaceMeshGrid', () => {
  it('15×15 顶点与三角形数量', () => {
    const { vertices, indices } = buildFaceMeshGrid()
    expect(MESH_DIM).toBe(15)
    expect(MESH_SEG).toBe(14)
    expect(vertices.length).toBe(225)
    expect(indices.length % 3).toBe(0)
    expect(indices.length / 3).toBe(14 * 14 * 2)
  })

  it('Parallax 权重在锚点附近更高', () => {
    const { vertices } = buildFaceMeshGrid({ anchorUv: { x: 0.5, y: 0.42 } })
    const near = vertices[7 * MESH_DIM + 7]!
    const far = vertices[0]!
    expect(near.parallaxWeight).toBeGreaterThan(far.parallaxWeight)
  })

  it('rotation 下鼻区附近 |dx| 大于角点', () => {
    const mesh = buildFaceMeshGrid()
    const d = applyParallaxOffsets(mesh.vertices, 0.15, 0.1)
    const idxN = 6 * MESH_DIM + 7
    const n = Math.abs(d[idxN]!.x - mesh.vertices[idxN]!.x)
    const c = Math.abs(d[0]!.x - mesh.vertices[0]!.x)
    expect(n).toBeGreaterThan(c)
  })
})
