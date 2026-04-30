export type InputHistoryState = {
  items: string[]
  index: number
  draft: string
}

export type NavigateHistoryResult = InputHistoryState & {
  value: string
  changed: boolean
}

export function parseInputHistory(raw: string | null, max: number): string[] {
  try {
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .slice(-max)
  } catch {
    return []
  }
}

export function rememberInput(items: string[], raw: string, max: number): InputHistoryState {
  const value = raw.trimEnd()
  if (!value.trim()) {
    return { items, index: items.length, draft: '' }
  }
  let next = items
  if (items[items.length - 1] !== value) {
    next = [...items, value].slice(-max)
  }
  return { items: next, index: next.length, draft: '' }
}

export function canNavigateInputHistory(
  direction: 'up' | 'down',
  value: string,
  selectionStart: number | null | undefined,
  historyLength: number,
): boolean {
  if (historyLength === 0) return false
  const pos = selectionStart ?? value.length
  if (direction === 'up') return !value.slice(0, pos).includes('\n')
  return !value.slice(pos).includes('\n')
}

export function navigateInputHistory(
  state: InputHistoryState,
  direction: 'up' | 'down',
  currentValue: string,
): NavigateHistoryResult {
  const draft = state.index === state.items.length ? currentValue : state.draft
  const delta = direction === 'up' ? -1 : 1
  const index = Math.max(0, Math.min(state.items.length, state.index + delta))
  if (index === state.index) {
    return { ...state, value: currentValue, changed: false }
  }
  return {
    items: state.items,
    index,
    draft,
    value: index === state.items.length ? draft : state.items[index]!,
    changed: true,
  }
}
