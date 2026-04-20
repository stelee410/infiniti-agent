/** 呼吸 + 随机眼神微动（SPEC：正弦 1–2px；3–5s 随机偏移） */

export type IdlenessSample = {
  breathY: number
  gazeX: number
  gazeY: number
}

export function createIdleness(opts?: { breathHz?: number; breathAmpPx?: number }): {
  tick: (dtMs: number) => IdlenessSample
} {
  const hz = opts?.breathHz ?? 0.35
  const amp = opts?.breathAmpPx ?? 1.5
  let tSec = 0
  let nextGazeMs = 3000 + Math.random() * 2000
  let gazeX = 0
  let gazeY = 0

  return {
    tick(dtMs: number): IdlenessSample {
      tSec += dtMs / 1000
      const breathY = Math.sin(tSec * hz * Math.PI * 2) * amp
      nextGazeMs -= dtMs
      if (nextGazeMs <= 0) {
        nextGazeMs = 3000 + Math.random() * 2000
        gazeX = (Math.random() - 0.5) * 4
        gazeY = (Math.random() - 0.5) * 2
      }
      return { breathY, gazeX, gazeY }
    },
  }
}
