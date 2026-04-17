/**
 * 浏览器与 Node 共用：无 node:fs / node:path，供 Vite 打包 liveui 引用。
 * 磁盘读取见 spriteExpressionManifest.ts。
 */

/** 与 `live2d-models/.../expression/expressions.json` 对齐 */
export type SpriteExpressionManifestV1 = {
  version: 1
  /** 每条对应一张 `{id}.png`（如 exp_01） */
  entries: Array<{
    id: string
    /** 小写情感键，与流式标签解析后 expression 名一致（如 happy、sad） */
    emotions: string[]
    label?: string
  }>
}

const DEFAULT_TAG_NAMES_FOR_STRIP = [
  'Happy',
  'Joy',
  'Sad',
  'Sadness',
  'Fear',
  'Angry',
  'Anger',
  'Thinking',
  'Think',
  'Blush',
  'Smirk',
  'Disgust',
  'Neutral',
  'Calm',
  'Surprise',
  'Surprised',
  'Frown',
]

/** 与当前 liveui `emotionToExpressionId` 默认表一致（无 manifest 时使用） */
export function defaultLunaStyleManifest(): SpriteExpressionManifestV1 {
  return {
    version: 1,
    entries: [
      { id: 'exp_01', emotions: ['neutral', 'calm'], label: 'Neutral' },
      { id: 'exp_02', emotions: ['sad', 'sadness', 'fear', 'unhappy'], label: 'Sad' },
      { id: 'exp_03', emotions: ['happy', 'joy', '开心'], label: 'Happy' },
      { id: 'exp_04', emotions: ['smirk', 'disgust', 'blush', '害羞'], label: 'Smirk' },
      { id: 'exp_05', emotions: ['think', 'thinking', '思考'], label: 'Thinking' },
      { id: 'exp_06', emotions: ['angry', 'anger', '生气'], label: 'Angry' },
      { id: 'exp_07', emotions: ['surprised', 'surprise', '惊讶'], label: 'Surprised' },
      { id: 'exp_08', emotions: ['frown', '皱眉'], label: 'Frown' },
    ],
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 英文情感键 → LiveUI 行首标签形式（首词首字母大写，下划线分节）；中文等原样返回 */
export function emotionKeyToStreamTagName(key: string): string {
  const t = key.trim()
  if (!t) return t
  if (/[^\x00-\x7f]/.test(t)) return t
  const parts = t.split(/[_\s]+/).filter(Boolean)
  if (parts.length === 0) return t
  return parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('_')
}

export function buildEmotionToSpriteIdFromManifest(m: SpriteExpressionManifestV1): Record<string, string> {
  const out: Record<string, string> = {}
  for (const ent of m.entries) {
    const id = ent.id.trim()
    if (!id) continue
    for (const em of ent.emotions) {
      const k = em.trim().toLowerCase()
      if (k) out[k] = id
    }
  }
  return out
}

export function collectStreamTagNamesFromManifest(m: SpriteExpressionManifestV1): string[] {
  const set = new Set<string>()
  for (const ent of m.entries) {
    for (const em of ent.emotions) {
      set.add(emotionKeyToStreamTagName(em.trim()))
    }
  }
  return [...set].filter(Boolean)
}

/** 供 strip 与提示词：合并默认英文标签与 manifest 衍生标签 */
export function allKnownStreamTagNamesForStrip(manifest?: SpriteExpressionManifestV1 | null): string[] {
  const set = new Set<string>(DEFAULT_TAG_NAMES_FOR_STRIP)
  if (manifest) {
    for (const t of collectStreamTagNamesFromManifest(manifest)) {
      set.add(t)
    }
  }
  return [...set]
}

export function buildStripKnownEmotionTagsRegex(manifest?: SpriteExpressionManifestV1 | null): RegExp {
  const names = allKnownStreamTagNamesForStrip(manifest)
  const inner = names.map(escapeRegExp).join('|')
  return new RegExp(`\\[(?:${inner})\\]\\s*`, 'gi')
}

export function buildLiveUiExpressionNudgeFromManifest(m: SpriteExpressionManifestV1): string {
  const tags = collectStreamTagNamesFromManifest(m)
  const unique = [...new Set(tags)]
  const bracketed = unique.map((t) => `[${t}]`).join('、')
  return `你是一个桌面助手。在输出每段话之前，必须先根据语气选择一个表情标签，格式为 [表情名]。当前角色精灵可用的表情标签（英文首字母大写或中文，与资源目录 expressions.json 一致）：${bracketed}。例如：[Happy]太棒了，我们开始吧！`
}

export function parseSpriteExpressionManifest(raw: unknown): SpriteExpressionManifestV1 {
  if (!raw || typeof raw !== 'object') {
    throw new Error('expressions.json 根须为对象')
  }
  const o = raw as Record<string, unknown>
  if (o.version !== 1) throw new Error('expressions.json 仅支持 version: 1')
  const entriesRaw = o.entries
  if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
    throw new Error('expressions.json 缺少 entries 数组')
  }
  const entries: SpriteExpressionManifestV1['entries'] = []
  for (const row of entriesRaw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    if (!id) continue
    const emotions: string[] = []
    if (Array.isArray(r.emotions)) {
      for (const e of r.emotions) {
        if (typeof e === 'string' && e.trim()) emotions.push(e.trim())
      }
    }
    if (!emotions.length) continue
    const label = typeof r.label === 'string' ? r.label.trim() : undefined
    entries.push({ id, emotions, ...(label ? { label } : {}) })
  }
  if (!entries.length) throw new Error('expressions.json entries 无有效项')
  return { version: 1, entries }
}
