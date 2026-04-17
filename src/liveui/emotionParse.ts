import type { PersistedMessage } from '../llm/persisted.js'
import type { LiveUiActionMessage } from './protocol.js'
import {
  buildStripKnownEmotionTagsRegex,
  type SpriteExpressionManifestV1,
} from './spriteExpressionManifestCore.js'

const LEADING_TAGS_RE = /^((\[[^\]]+\])\s*)+/

/** 无 manifest 时与历史行为一致 */
const DEFAULT_STRIP_KNOWN_EMO_TAGS = buildStripKnownEmotionTagsRegex(null)

/** 展示用：去掉正文中任意位置的 LiveUI 标准表情标签（可与 expressions.json 扩展标签对齐）。 */
export function stripLiveUiKnownEmotionTagsEverywhere(
  text: string,
  manifest?: SpriteExpressionManifestV1 | null,
): string {
  const re = manifest ? buildStripKnownEmotionTagsRegex(manifest) : DEFAULT_STRIP_KNOWN_EMO_TAGS
  return text.replace(re, '')
}

/** 解析 [tag] 内文本，忽略大小写（英文） */
function mapTagInner(innerRaw: string): { expression?: string; motion?: string } | null {
  const inner = innerRaw.trim()
  if (!inner) return null
  const lower = inner.toLowerCase()

  const emotion: Record<string, { expression: string }> = {
    happy: { expression: 'happy' },
    joy: { expression: 'happy' },
    开心: { expression: 'happy' },
    sad: { expression: 'sad' },
    sadness: { expression: 'sad' },
    unhappy: { expression: 'sad' },
    fear: { expression: 'sad' },
    悲伤: { expression: 'sad' },
    angry: { expression: 'angry' },
    anger: { expression: 'angry' },
    生气: { expression: 'angry' },
    think: { expression: 'thinking' },
    thinking: { expression: 'thinking' },
    思考: { expression: 'thinking' },
    blush: { expression: 'blush' },
    害羞: { expression: 'blush' },
    smirk: { expression: 'smirk' },
    disgust: { expression: 'disgust' },
    neutral: { expression: 'neutral' },
    calm: { expression: 'neutral' },
    平静: { expression: 'neutral' },
    surprise: { expression: 'surprised' },
    surprised: { expression: 'surprised' },
    惊讶: { expression: 'surprised' },
    frown: { expression: 'frown' },
    皱眉: { expression: 'frown' },
  }

  const motions: Record<string, { motion: string }> = {
    wave: { motion: 'wave' },
    挥手: { motion: 'wave' },
    nod: { motion: 'nod' },
    点头: { motion: 'nod' },
    yawn: { motion: 'yawn' },
    打哈欠: { motion: 'yawn' },
  }

  if (emotion[lower]) return emotion[lower]
  if (emotion[inner]) return emotion[inner]
  if (motions[lower]) return motions[lower]
  if (motions[inner]) return motions[inner]
  return { expression: lower.replace(/\s+/g, '_') }
}

export type LiveUiActionPayload = LiveUiActionMessage['data']

export type StreamLiveUiState = {
  /** 已对前缀标签发送过 ACTION 的字符长度（completePrefix.length） */
  emittedTagPrefixLen: number
}

export function createStreamLiveUiState(): StreamLiveUiState {
  return { emittedTagPrefixLen: 0 }
}

/**
 * 从流式累积文本中：解析**完整**行首 [tag]、得到 TUI 展示文本、以及本轮新出现的 ACTION。
 * 若行首存在未闭合的 `[`，展示文本为空，避免把未完成标签打给用户。
 */
export function processAssistantStreamChunk(
  state: StreamLiveUiState,
  fullRaw: string,
): { displayText: string; newActions: LiveUiActionPayload[] } {
  const m = fullRaw.match(LEADING_TAGS_RE)
  const completePrefix = m ? m[0] : ''
  const after = fullRaw.slice(completePrefix.length)
  const displayText = /^\[[^\]]*$/.test(after) ? '' : after

  const newSlice = completePrefix.slice(state.emittedTagPrefixLen)
  state.emittedTagPrefixLen = completePrefix.length

  const newActions: LiveUiActionPayload[] = []
  for (const g of newSlice.matchAll(/\[([^\]]+)\]/g)) {
    const inner = g[1] ?? ''
    const mapped = mapTagInner(inner)
    if (mapped) newActions.push(mapped)
  }

  return { displayText, newActions }
}

/**
 * 持久化前移除行首连续 [tag]（仅完整标签），不影响正文中间的中括号内容。
 */
export function stripLeadingLiveUiTags(text: string): string {
  const m = text.match(LEADING_TAGS_RE)
  if (!m) return text
  return text.slice(m[0].length)
}

/** 持久化前：去掉 assistant 行首连续标签，并去掉正文中标准五类 [Happy] 等标记。 */
export function stripLiveUiTagsFromMessages(
  messages: PersistedMessage[],
  manifest?: SpriteExpressionManifestV1 | null,
): PersistedMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant') return m
    if (typeof m.content !== 'string') return m
    const next = stripLiveUiKnownEmotionTagsEverywhere(stripLeadingLiveUiTags(m.content), manifest)
    if (next === m.content) return m
    return { ...m, content: next }
  })
}
