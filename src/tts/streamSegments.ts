export const TTS_MAX_SEGMENT_CHARS = 96

const SENTENCE_END_CHARS = new Set(['。', '！', '？', '；', '、', '.', '!', '?', '\n', '，', ','])
const SOFT_BREAK_CHARS = ['，', '、', '；', ',', ';', '：', ' ', '　']

export type TtsTextSegment = {
  text: string
  start: number
  end: number
}

function trimRange(source: string, start: number, end: number): { start: number; end: number } {
  let s = start
  let e = end
  while (s < e && /\s/.test(source[s]!)) s++
  while (e > s && /\s/.test(source[e - 1]!)) e--
  return { start: s, end: e }
}

function splitSentenceRanges(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let start = 0
  let i = 0
  while (i < text.length) {
    if (!SENTENCE_END_CHARS.has(text[i]!)) {
      i++
      continue
    }
    let end = i + 1
    while (end < text.length && /\s/.test(text[end]!)) end++
    out.push({ start, end })
    start = end
    i = end
  }
  if (start < text.length) {
    out.push({ start, end: text.length })
  }
  return out
}

function splitLongRange(
  source: string,
  rangeStart: number,
  rangeEnd: number,
  maxChars: number,
): TtsTextSegment[] {
  const trimmed = trimRange(source, rangeStart, rangeEnd)
  if (trimmed.start >= trimmed.end) return []

  const t = source.slice(trimmed.start, trimmed.end)
  if (t.length <= maxChars) {
    return [{ text: t, start: trimmed.start, end: trimmed.end }]
  }

  const out: TtsTextSegment[] = []
  let i = 0
  while (i < t.length) {
    let end = Math.min(i + maxChars, t.length)
    if (end < t.length) {
      const window = t.slice(i, end)
      const lastBreak = Math.max(...SOFT_BREAK_CHARS.map((ch) => window.lastIndexOf(ch)), -1)
      if (lastBreak >= 8) end = i + lastBreak + 1
    }

    const rawStart = trimmed.start + i
    const rawEnd = trimmed.start + end
    const part = trimRange(source, rawStart, rawEnd)
    if (part.start < part.end) {
      out.push({
        text: source.slice(part.start, part.end),
        start: part.start,
        end: part.end,
      })
    }
    i = end
  }
  return out
}

export function splitTtsSegmentsWithSpans(
  text: string,
  maxChars: number = TTS_MAX_SEGMENT_CHARS,
): TtsTextSegment[] {
  return splitSentenceRanges(text).flatMap((r) => splitLongRange(text, r.start, r.end, maxChars))
}

export function splitTtsSegments(text: string): string[] {
  return splitTtsSegmentsWithSpans(text).map((s) => s.text)
}

export function collectNewTtsSegments(
  text: string,
  cursor: number,
  opts: { final?: boolean } = {},
): { segments: string[]; cursor: number } {
  const all = splitTtsSegmentsWithSpans(text)
  const candidates = opts.final ? all : all.slice(0, -1)
  const segments: string[] = []
  let nextCursor = Math.max(0, Math.min(cursor, text.length))

  for (const seg of candidates) {
    if (seg.end <= nextCursor) continue
    const source = seg.start < nextCursor ? text.slice(nextCursor, seg.end) : seg.text
    const clean = source.trim()
    if (clean) segments.push(clean)
    nextCursor = seg.end
  }

  return { segments, cursor: nextCursor }
}
