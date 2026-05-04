export type AssistantContentLayoutInput = {
  text: string
  barHeight: number
  viewportHeight: number
  minimalMode: boolean
}

export type AssistantContentLayoutPlan = {
  bubbleLines: number
  minWindowHeight: number
}

const DEFAULT_BUBBLE_LINES = 3
const MIN_BUBBLE_LINES = 2
const MAX_BUBBLE_LINES = 6
const APPROX_CHARS_PER_LINE = 34
const LINE_HEIGHT_PX = 15 * 1.55
const EXTRA_WINDOW_HEIGHT_PER_LINE = 28

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function estimateAssistantBubbleLines(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return DEFAULT_BUBBLE_LINES
  const hardLines = trimmed.split(/\n+/).filter((line) => line.trim()).length
  const compactChars = trimmed.replace(/\s+/g, '').length
  const softLines = Math.ceil(compactChars / APPROX_CHARS_PER_LINE)
  const estimated = Math.max(hardLines, softLines)
  if (estimated <= 2) return 2
  if (estimated <= 3) return 3
  if (estimated <= 5) return 4
  if (estimated <= 8) return 5
  return 6
}

export function computeAssistantContentLayoutPlan(
  input: AssistantContentLayoutInput,
): AssistantContentLayoutPlan {
  const viewportCapLines = Math.max(
    MIN_BUBBLE_LINES,
    Math.min(MAX_BUBBLE_LINES, Math.floor(Math.max(180, input.viewportHeight) * 0.22 / LINE_HEIGHT_PX)),
  )
  const bubbleLines = input.minimalMode
    ? DEFAULT_BUBBLE_LINES
    : clamp(estimateAssistantBubbleLines(input.text), MIN_BUBBLE_LINES, viewportCapLines)
  const extraLines = Math.max(0, bubbleLines - DEFAULT_BUBBLE_LINES)
  return {
    bubbleLines,
    minWindowHeight: Math.max(
      360,
      input.barHeight + 220 + extraLines * EXTRA_WINDOW_HEIGHT_PER_LINE,
    ),
  }
}
