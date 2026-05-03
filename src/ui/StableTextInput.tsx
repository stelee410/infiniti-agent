import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box, Text, useCursor, useInput } from 'ink'
import type { DOMElement, Key } from 'ink'

const CSI_INVERSE = '\x1b[7m'
const CSI_INVERSE_OFF = '\x1b[27m'
const CSI_DIM = '\x1b[2m'
const CSI_DIM_OFF = '\x1b[22m'

type Props = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  placeholder?: string
  focus?: boolean
  showCursor?: boolean
  columns: number
  prefix?: string
  prefixWidth?: number
  nativeCursorY?: number
}

type Grapheme = {
  segment: string
  index: number
  width: number
}

type RenderState = {
  text: string
  cursorColumn: number
}

export function StableTextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  focus = true,
  showCursor = true,
  columns,
  prefix = '› ',
  prefixWidth = widthOf(prefix),
  nativeCursorY,
}: Props): React.ReactElement {
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const cursorOffsetRef = useRef(cursorOffset)
  const valueRef = useRef(value)
  const rowRef = useNativeCursor({
    active: focus && showCursor,
    line: 0,
    column: prefixWidth + renderInput(value, cursorOffset, columns, prefixWidth).cursorColumn,
    absoluteY: nativeCursorY,
  })

  cursorOffsetRef.current = cursorOffset
  valueRef.current = value

  useEffect(() => {
    setCursorOffset((offset) => clampOffsetToGrapheme(value, offset))
  }, [value])

  const commit = useCallback(
    (nextValue: string, nextOffset: number) => {
      onChange(nextValue)
      setCursorOffset(clampOffsetToGrapheme(nextValue, nextOffset))
    },
    [onChange],
  )

  useInput(
    (input, key) => {
      if (key.tab || key.upArrow || key.downArrow) return
      if (key.ctrl && input === 'c') return

      const currentValue = valueRef.current
      const currentOffset = clampOffsetToGrapheme(currentValue, cursorOffsetRef.current)

      if (key.return) {
        onSubmit?.(currentValue)
        return
      }
      if (key.leftArrow) {
        setCursorOffset(prevOffset(currentValue, currentOffset))
        return
      }
      if (key.rightArrow) {
        setCursorOffset(nextOffset(currentValue, currentOffset))
        return
      }
      if (key.home || (key.ctrl && input === 'a')) {
        setCursorOffset(0)
        return
      }
      if (key.end || (key.ctrl && input === 'e')) {
        setCursorOffset(currentValue.length)
        return
      }
      if (key.backspace) {
        if (currentOffset === 0) return
        const start = prevOffset(currentValue, currentOffset)
        commit(currentValue.slice(0, start) + currentValue.slice(currentOffset), start)
        return
      }
      if (key.delete || (key.ctrl && input === 'd')) {
        if (currentOffset >= currentValue.length) return
        const end = nextOffset(currentValue, currentOffset)
        commit(currentValue.slice(0, currentOffset) + currentValue.slice(end), currentOffset)
        return
      }

      const text = normalizeTextInput(input, key)
      if (!text) return
      commit(currentValue.slice(0, currentOffset) + text + currentValue.slice(currentOffset), currentOffset + text.length)
    },
    { isActive: focus },
  )

  const state = renderInput(value, cursorOffset, columns, prefixWidth)
  const rendered =
    value.length === 0 && placeholder
      ? renderPlaceholder(placeholder, showCursor && focus)
      : renderWithCursor(state.text, state.cursorColumn, showCursor && focus)

  return (
    <Box ref={rowRef} flexDirection="row" flexGrow={1} minWidth={0} overflow="hidden">
      {prefix ? (
        <Text color="cyan" bold>
          {prefix}
        </Text>
      ) : null}
      <Text wrap="truncate-end">{rendered}</Text>
    </Box>
  )
}

function normalizeTextInput(input: string, key: Key): string {
  if (key.meta || key.ctrl) return ''
  return input
    .replace(/(?<=[^\\\r\n])\r$/u, '')
    .replace(/\r/g, '\n')
}

function renderPlaceholder(placeholder: string, active: boolean): string {
  if (!active) return dim(placeholder)
  const [first = '', rest = ''] = splitFirstGrapheme(placeholder)
  return inverse(first || ' ') + dim(rest)
}

function renderWithCursor(text: string, cursorColumn: number, active: boolean): string {
  if (!active) return text

  let before = ''
  let at = ' '
  let after = ''
  let width = 0
  let found = false

  for (const g of segmentText(text)) {
    if (found) {
      after += g.segment
      continue
    }
    const next = width + g.width
    if (next > cursorColumn) {
      at = g.segment
      found = true
    } else {
      before += g.segment
      width = next
    }
  }

  return before + inverse(at) + after
}

function renderInput(value: string, cursorOffset: number, columns: number, prefixWidth: number): RenderState {
  const width = Math.max(1, columns - prefixWidth)
  const normalizedOffset = clampOffsetToGrapheme(value, cursorOffset)
  const fullCursorColumn = widthOf(value.slice(0, normalizedOffset))
  const viewportStart = viewportStartForCursor(value, normalizedOffset, width)
  const text = value.slice(viewportStart)
  const cursorColumn = widthOf(value.slice(viewportStart, normalizedOffset))

  return {
    text,
    cursorColumn: Math.min(fullCursorColumn, cursorColumn),
  }
}

function viewportStartForCursor(value: string, cursorOffset: number, width: number): number {
  let start = 0
  while (widthOf(value.slice(start, cursorOffset)) >= width) {
    const next = nextOffset(value, start)
    if (next === start) break
    start = next
  }
  return start
}

function prevOffset(text: string, offset: number): number {
  let prev = 0
  for (const g of segmentText(text)) {
    if (g.index >= offset) break
    prev = g.index
  }
  return prev
}

function nextOffset(text: string, offset: number): number {
  for (const g of segmentText(text)) {
    if (g.index > offset) return g.index
    if (g.index === offset) return g.index + g.segment.length
  }
  return text.length
}

function clampOffsetToGrapheme(text: string, offset: number): number {
  if (offset <= 0) return 0
  if (offset >= text.length) return text.length
  let best = 0
  for (const g of segmentText(text)) {
    if (g.index > offset) break
    best = g.index
  }
  return best
}

function segmentText(text: string): Grapheme[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return Array.from(segmenter.segment(text.normalize('NFC')), ({ segment, index }) => ({
    segment,
    index,
    width: cellWidth(segment),
  }))
}

function widthOf(text: string): number {
  let width = 0
  for (const g of segmentText(text)) {
    width += g.width
  }
  return width
}

function cellWidth(segment: string): number {
  const cp = segment.codePointAt(0) ?? 0
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp >= 0x300 && cp <= 0x36f) return 0
  if (isWideCodePoint(cp)) return 2
  return 1
}

function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff))
  )
}

function inverse(text: string): string {
  return `${CSI_INVERSE}${text}${CSI_INVERSE_OFF}`
}

function dim(text: string): string {
  return `${CSI_DIM}${text}${CSI_DIM_OFF}`
}

function useNativeCursor({
  active,
  line,
  column,
  absoluteY,
}: {
  active: boolean
  line: number
  column: number
  absoluteY?: number
}): (element: DOMElement | null) => void {
  const { setCursorPosition } = useCursor()
  const nodeRef = useRef<DOMElement | null>(null)
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)

  const ref = useCallback((node: DOMElement | null) => {
    nodeRef.current = node
  }, [])

  useLayoutEffect(() => {
    const next = nodeRef.current ? absolutePosition(nodeRef.current) : null
    setOrigin((prev) => (
      prev?.x === next?.x && prev?.y === next?.y ? prev : next
    ))
  })

  setCursorPosition(
    active && origin
      ? {
          x: Math.max(0, origin.x + column),
          y: Math.max(0, absoluteY ?? origin.y + line),
        }
      : undefined,
  )

  return ref
}

function absolutePosition(node: DOMElement): { x: number; y: number } {
  let x = 0
  let y = 0
  let cursor: DOMElement | undefined = node
  while (cursor) {
    x += cursor.yogaNode?.getComputedLeft() ?? 0
    y += cursor.yogaNode?.getComputedTop() ?? 0
    cursor = cursor.parentNode
  }
  return { x, y }
}
function splitFirstGrapheme(text: string): [string, string] {
  const first = segmentText(text)[0]?.segment ?? ''
  return [first, text.slice(first.length)]
}
