/** 口型时间轴：无 TTS 时用字符粗映射 + 多通道 viseme + smooth 插值 */

/** 与 exp_speaking_{a,e,i,o,u}.png 一一对应，用于贴图替换 */
export type VowelSlot = 'a' | 'e' | 'i' | 'o' | 'u'

export type MouthTargets = {
  openness: number
  /** 0..1 嘴角外展（扁、大开口感，a / e） */
  spread: number
  /** 0..1 圆唇（o / u） */
  pucker: number
  /** 0..1 扁长唇（i / 细元音） */
  narrow: number
}

export type VisemeSeg = MouthTargets & {
  startMs: number
  endMs: number
  /** 当前段使用的元音口型贴图；闭嘴段为占位 */
  vowelSlot: VowelSlot
}

const ZERO: MouthTargets = { openness: 0, spread: 0, pucker: 0, narrow: 0 }

function isLatin(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
}

/** 统一压低唇三通道与峰值张口，避免 mesh 变化过猛 */
function attenuateMouth(m: MouthTargets): MouthTargets {
  const lipK = 0.48
  const openK = 0.9
  return {
    openness: Math.min(0.44, m.openness * openK),
    spread: m.spread * lipK,
    pucker: m.pucker * lipK,
    narrow: m.narrow * lipK,
  }
}

function visemeRaw(ch: string): MouthTargets {
  if (/\s/.test(ch)) return { ...ZERO }
  const la = ch.toLowerCase()
  if (isLatin(ch)) {
    if ('aeiou'.includes(la)) {
      if (la === 'a')
        return { openness: 0.52, spread: 0.92, pucker: 0.06, narrow: 0.08 }
      if (la === 'e')
        return { openness: 0.42, spread: 0.58, pucker: 0.12, narrow: 0.28 }
      if (la === 'i' || la === 'y')
        return { openness: 0.38, spread: 0.18, pucker: 0.08, narrow: 0.92 }
      if (la === 'o')
        return { openness: 0.5, spread: 0.12, pucker: 0.94, narrow: 0.1 }
      if (la === 'u' || la === 'w')
        return { openness: 0.48, spread: 0.1, pucker: 0.96, narrow: 0.18 }
      return { openness: 0.42, spread: 0.42, pucker: 0.35, narrow: 0.22 }
    }
    if ('mbp'.includes(la))
      return { openness: 0.06, spread: 0.12, pucker: 0.42, narrow: 0.08 }
    if ('fv'.includes(la))
      return { openness: 0.22, spread: 0.38, pucker: 0.18, narrow: 0.32 }
    if ('l'.includes(la))
      return { openness: 0.3, spread: 0.35, pucker: 0.22, narrow: 0.45 }
    if ('wy'.includes(la))
      return { openness: 0.34, spread: 0.28, pucker: 0.2, narrow: 0.55 }
    if ('tdn'.includes(la))
      return { openness: 0.18, spread: 0.32, pucker: 0.25, narrow: 0.38 }
    if ('kg'.includes(la))
      return { openness: 0.24, spread: 0.3, pucker: 0.28, narrow: 0.28 }
    if ('sch'.includes(la) || la === 'r')
      return { openness: 0.26, spread: 0.4, pucker: 0.35, narrow: 0.3 }
    return { openness: 0.22, spread: 0.35, pucker: 0.25, narrow: 0.3 }
  }
  if (/[\u4e00-\u9fff]/.test(ch)) {
    const u = ch.codePointAt(0)!
    const o = 0.2 + (u % 13) * 0.022
    const spread = 0.32 + (u % 11) * 0.05
    const pucker = ((u >> 2) % 9) * 0.09
    const narrow = ((u >> 5) % 7) * 0.1
    return { openness: Math.min(0.55, o), spread: Math.min(0.95, spread), pucker, narrow: Math.min(0.85, narrow) }
  }
  return { openness: 0.22, spread: 0.35, pucker: 0.22, narrow: 0.28 }
}

function visemeForChar(ch: string): MouthTargets {
  const raw = visemeRaw(ch)
  if (raw.openness === 0 && raw.spread === 0 && raw.pucker === 0 && raw.narrow === 0) return { ...ZERO }
  return attenuateMouth(raw)
}

/** 按字符选元音贴图槽；辅音/标点给中性 e，汉字在 a–u 间轮转 */
export function vowelSlotForChar(ch: string): VowelSlot {
  if (/\s/.test(ch)) return 'e'
  const la = ch.toLowerCase()
  if (isLatin(ch)) {
    if ('aeiou'.includes(la)) {
      if (la === 'a') return 'a'
      if (la === 'e') return 'e'
      if (la === 'i') return 'i'
      if (la === 'o') return 'o'
      if (la === 'u') return 'u'
    }
    if (la === 'y') return 'i'
    if (la === 'w') return 'u'
    if ('mbp'.includes(la)) return 'u'
    if ('fv'.includes(la)) return 'e'
    if ('tdnl'.includes(la)) return 'e'
    if ('kg'.includes(la)) return 'e'
    if ('sch'.includes(la) || la === 'r' || la === 'h') return 'e'
    return 'e'
  }
  if (/[\u4e00-\u9fff]/.test(ch)) {
    const u = ch.codePointAt(0)!
    const slots: VowelSlot[] = ['a', 'e', 'i', 'o', 'u']
    return slots[u % 5]!
  }
  return 'e'
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch)
}

function pauseMsForPunct(ch: string): number {
  if (/[。！？.!?]/.test(ch)) return 460
  if (/[，、；：,;:]/.test(ch)) return 300
  return 0
}

function splitSpeakDurations(total: number): { attack: number; hold: number; release: number } {
  const attack = Math.max(28, Math.round(total * 0.34))
  const release = Math.max(40, Math.round(total * 0.5))
  let hold = total - attack - release
  if (hold < 16) {
    const deficit = 16 - hold
    hold = 16
    const shrink = Math.min(attack - 20, release - 28, Math.ceil(deficit / 2))
    return {
      attack: Math.max(20, attack - shrink),
      hold,
      release: Math.max(28, release - shrink),
    }
  }
  return { attack, hold, release }
}

function scaleTargets(v: MouthTargets, k: number): MouthTargets {
  return {
    openness: v.openness * k,
    spread: v.spread * k,
    pucker: v.pucker * k,
    narrow: v.narrow * k,
  }
}

function pushVisemeSeg(
  segs: VisemeSeg[],
  start: number,
  end: number,
  m: MouthTargets,
  vowelSlot: VowelSlot,
): void {
  if (end <= start) return
  segs.push({ startMs: start, endMs: end, vowelSlot, ...m })
}

/**
 * 按字符切段：attack/hold/release；每段带完整 viseme，收嘴时各通道回 0。
 */
export function buildVisemeTimeline(text: string, msPerChar = 320): VisemeSeg[] {
  const segs: VisemeSeg[] = []
  let t = 0
  const s = text.trim().normalize('NFC')

  for (const ch of s) {
    if (isWhitespace(ch)) {
      const gap = Math.min(340, Math.max(140, Math.round(msPerChar * 1.15)))
      pushVisemeSeg(segs, t, t + gap, ZERO, 'e')
      t += gap
      continue
    }
    const punctPause = pauseMsForPunct(ch)
    if (punctPause > 0) {
      pushVisemeSeg(segs, t, t + punctPause, ZERO, 'e')
      t += punctPause
      continue
    }

    const peak = visemeForChar(ch)
    const vs = vowelSlotForChar(ch)
    const { attack, hold, release } = splitSpeakDurations(msPerChar)
    const t0 = t
    const tAttackEnd = t0 + attack
    const tHoldEnd = tAttackEnd + hold
    const tEnd = tHoldEnd + release

    pushVisemeSeg(segs, t0, tAttackEnd, scaleTargets(peak, 0.14), vs)
    pushVisemeSeg(segs, tAttackEnd, tHoldEnd, peak, vs)
    pushVisemeSeg(segs, tHoldEnd, tEnd, ZERO, vs)
    t = tEnd
  }

  if (segs.length === 0) {
    segs.push({ startMs: 0, endMs: 280, vowelSlot: 'e', ...ZERO })
  }
  return segs
}

/** 段内 ease：两端慢、中间匀，开合不像阶梯跳 */
function smoothEase01(u: number): number {
  const x = Math.min(1, Math.max(0, u))
  return x * x * (3 - 2 * x)
}

function findSegmentIndex(segs: readonly VisemeSeg[], elapsedMs: number): number {
  let i = 0
  while (i < segs.length && elapsedMs >= segs[i]!.endMs) i++
  return i
}

/** 当前时刻的口型目标（四通道同步插值） */
export function sampleMouthTargets(segs: readonly VisemeSeg[], elapsedMs: number): MouthTargets {
  if (!segs.length) return { ...ZERO }
  if (elapsedMs <= 0) return { ...ZERO }
  const last = segs[segs.length - 1]!
  if (elapsedMs >= last.endMs) return { ...ZERO }

  const i = findSegmentIndex(segs, elapsedMs)
  const cur = segs[i]
  if (!cur) return { ...ZERO }
  const u = (elapsedMs - cur.startMs) / (cur.endMs - cur.startMs)
  const uClamped = Math.min(1, Math.max(0, u))
  const su = smoothEase01(uClamped)
  const prev = i > 0 ? segs[i - 1]! : null

  const lerpCh = (key: keyof MouthTargets): number => {
    const pk = key as keyof MouthTargets
    if (!prev) return (cur[pk] as number) * su
    return (prev[pk] as number) + ((cur[pk] as number) - (prev[pk] as number)) * su
  }

  return {
    openness: lerpCh('openness'),
    spread: lerpCh('spread'),
    pucker: lerpCh('pucker'),
    narrow: lerpCh('narrow'),
  }
}

export function sampleOpenness(segs: readonly VisemeSeg[], elapsedMs: number): number {
  return sampleMouthTargets(segs, elapsedMs).openness
}

/** 当前段对应的元音贴图（不插值，按时间轴段离散切换） */
export function sampleVowelSlot(segs: readonly VisemeSeg[], elapsedMs: number): VowelSlot {
  if (!segs.length) return 'e'
  if (elapsedMs <= 0) return 'e'
  const last = segs[segs.length - 1]!
  if (elapsedMs >= last.endMs) return 'e'
  const i = findSegmentIndex(segs, elapsedMs)
  return segs[i]?.vowelSlot ?? 'e'
}

/** 嘴唇几何强度（用于 calm/speaking：低张口时仍可显示圆唇/扁唇） */
export function lipShapeEnergy(m: MouthTargets): number {
  return Math.max(m.spread, m.pucker, m.narrow)
}

export function totalDurationMs(segs: readonly VisemeSeg[]): number {
  if (!segs.length) return 0
  return segs[segs.length - 1]!.endMs + 520
}
