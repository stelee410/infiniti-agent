/** 从 Agent 文本中解析 [Tag] 并映射为 0..1 情绪强度（供 Hybrid 层叠强度调制） */

const TAG_RE = /\[([^\]]+)\]/g

const TABLE: Record<string, number> = {
  smile: 0.85,
  happy: 0.9,
  joy: 0.9,
  laugh: 1,
  sad: 0.75,
  angry: 0.88,
  fear: 0.7,
  neutral: 0.15,
  calm: 0.12,
  think: 0.35,
  thinking: 0.35,
  surprise: 0.8,
  surprised: 0.8,
  blush: 0.55,
}

function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '_')
}

export type EmotionParseResult = {
  tags: string[]
  /** 所有命中标签中的最大强度 */
  maxIntensity: number
}

export function parseEmotionIntensityFromText(text: string): EmotionParseResult {
  const tags: string[] = []
  let maxIntensity = 0
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(text)) !== null) {
    const raw = m[1] ?? ''
    const inner = raw.trim()
    if (!inner) continue
    tags.push(inner)
    const k = normKey(inner)
    const v = TABLE[k] ?? 0.4
    if (v > maxIntensity) maxIntensity = v
  }
  return { tags, maxIntensity }
}
