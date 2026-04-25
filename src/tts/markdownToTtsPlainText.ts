const EMOJI_RE =
  /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Emoji_Presentation}](?:[\uFE0E\uFE0F])?(?:\u200D[\p{Extended_Pictographic}\p{Emoji_Presentation}](?:[\uFE0E\uFE0F])?)*)/gu

function stripParentheticalContent(source: string): string {
  const pairs = new Map<string, string>([
    ['(', ')'],
    ['（', '）'],
  ])
  const closes = new Set([...pairs.values()])
  let depth = 0
  let out = ''

  for (const ch of source) {
    if (pairs.has(ch)) {
      if (depth === 0) out += ' '
      depth++
      continue
    }
    if (closes.has(ch) && depth > 0) {
      depth--
      if (depth === 0) out += ' '
      continue
    }
    if (depth === 0) out += ch
  }

  return out
}

/**
 * 将助手输出中的 Markdown / 轻量标记收口为适合 TTS 的纯文本。
 * 不做完整 CommonMark 解析，用启发式剥离常见语法，避免朗读「井号、星号、链接」、括号旁白和 emoji 等。
 */
export function markdownToTtsPlainText(source: string): string {
  let s = String(source ?? '')

  // 围栏代码块
  s = s.replace(/```[\w-]*\n?[\s\S]*?```/g, ' ')

  // 行内 HTML 标签
  s = s.replace(/<\/[a-z][\w-]*>/gi, ' ')
  s = s.replace(/<[a-z][\w-]*(?:\s[^>]*)?>/gi, ' ')

  // 图片 ![alt](url) → alt；链接 [text](url) → text
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 裸 URL
  s = s.replace(/https?:\/\/[^\s)\]>]+/gi, ' ')

  // 标题、引用、分隔线
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/^\s*>\s?/gm, '')
  s = s.replace(/^[-*_]{3,}\s*$/gm, ' ')

  // 列表、任务列表
  s = s.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
  s = s.replace(/^\s*[-*+]\s+(?=\S)/gm, '')
  s = s.replace(/^\s*\d+\.\s+/gm, '')

  // 脚注引用 [^n]
  s = s.replace(/\[\^[^\]]+\]/g, ' ')

  // 删除线、加粗、斜体（多轮以处理嵌套）
  let prev = ''
  while (prev !== s) {
    prev = s
    s = s.replace(/~~(.*?)~~/gs, '$1')
    s = s.replace(/\*\*(.+?)\*\*/gs, '$1')
    s = s.replace(/__(.+?)__/gs, '$1')
    s = s.replace(/\*([^*\n]+)\*/g, '$1')
    s = s.replace(/_([^_\n]+)_/g, '$1')
  }

  // 行内代码 `...`
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/`+/g, ' ')

  // TTS 不朗读括号内旁白/动作提示与 emoji。
  s = stripParentheticalContent(s)
  s = s.replace(EMOJI_RE, ' ')

  // 表格行里多余竖线 → 空格（避免朗读「竖线」）
  s = s.replace(/\s*\|\s*/g, ' ')

  s = s.replace(/\*{2,}/g, ' ')
  s = s.replace(/_{2,}/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}
