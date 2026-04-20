/** Rhubarb 风格精简音素子集（6–9 个标签便于前端状态机） */
export type Real2dPhoneme = 'X' | 'A' | 'O' | 'M' | 'E' | 'I' | 'U' | 'F' | 'L'

const BLEND_MS = 60

function jawTargetForPhoneme(p: Real2dPhoneme): number {
  switch (p) {
    case 'M':
    case 'X':
      return 0
    case 'A':
    case 'O':
      return 1
    case 'E':
    case 'I':
      return 0.65
    case 'U':
      return 0.45
    case 'F':
      return 0.25
    case 'L':
      return 0.35
    default:
      return 0
  }
}

/** 口型层 cross-fade：闭嘴贴图 0，开嘴贴图 1（与 jaw 同步简化） */
function mouthLayerForPhoneme(p: Real2dPhoneme): number {
  return jawTargetForPhoneme(p)
}

export type PhonemeDrive = {
  phoneme: Real2dPhoneme
  /** 0=闭嘴 … 1=大张嘴，用于网格下巴带 + 贴图淡入 */
  jawOpen: number
  /** 0=层 A（闭嘴切片）… 1=层 B（开嘴切片） */
  mouthLayerB: number
}

export class PhonemeStateMachine {
  private current: Real2dPhoneme = 'X'
  private jawOpen = 0
  private mouthLayerB = 0
  private jawStart = 0
  private mouthStart = 0
  private jawEnd = 0
  private mouthEnd = 0
  private blendElapsedMs = 0
  private blending = false

  getDrive(): PhonemeDrive {
    return {
      phoneme: this.current,
      jawOpen: this.jawOpen,
      mouthLayerB: this.mouthLayerB,
    }
  }

  /** 设置新音素；从 M→A 等变化时在 BLEND_MS 内完成下巴与贴图插值 */
  setPhoneme(next: Real2dPhoneme): void {
    this.current = next
    this.jawStart = this.jawOpen
    this.mouthStart = this.mouthLayerB
    this.jawEnd = jawTargetForPhoneme(next)
    this.mouthEnd = mouthLayerForPhoneme(next)
    this.blendElapsedMs = 0
    this.blending = true
  }

  tick(dtMs: number): void {
    if (!this.blending) return
    this.blendElapsedMs += dtMs
    const t = Math.min(1, this.blendElapsedMs / BLEND_MS)
    this.jawOpen = this.jawStart + (this.jawEnd - this.jawStart) * t
    this.mouthLayerB = this.mouthStart + (this.mouthEnd - this.mouthStart) * t
    if (t >= 1) this.blending = false
  }
}
