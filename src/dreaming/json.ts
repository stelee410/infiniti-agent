export function parseJsonObject<T>(raw: string): T | null {
  const trimmed = raw.trim()
  const candidates = [trimmed, extractJson(trimmed)].filter((v): v is string => Boolean(v))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as T
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function extractJson(input: string): string | null {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const start = input.indexOf('{')
  const end = input.lastIndexOf('}')
  if (start >= 0 && end > start) return input.slice(start, end + 1)
  return null
}
