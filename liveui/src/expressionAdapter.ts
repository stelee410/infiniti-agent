import type { Emotion as Real2dEmotion } from './real2d/types/index.ts'

export type RendererKind = 'real2d' | 'sprite' | 'live2d' | 'placeholder'

export type AdaptedExpression = {
  expression: string
  intensity: number
  semantic: string
  fallbackUsed: boolean
}

const REAL2D_EMOTIONS = new Set<Real2dEmotion>([
  'neutral',
  'happy',
  'sad',
  'angry',
  'thinking',
  'surprised',
  'shy',
])

const SEMANTIC_ALIASES: Record<string, string> = {
  joy: 'happy',
  warm: 'happy',
  delighted: 'happy',
  careful: 'thinking',
  focused: 'thinking',
  focus: 'thinking',
  processing: 'thinking',
  think: 'thinking',
  confused: 'thinking',
  worried: 'sad',
  tired: 'sad',
  sadness: 'sad',
  unhappy: 'sad',
  fear: 'sad',
  anger: 'angry',
  mad: 'angry',
  surprise: 'surprised',
  shocked: 'surprised',
  blush: 'shy',
  bashful: 'shy',
  smirk: 'happy',
  disgust: 'angry',
  calm: 'neutral',
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function normalize(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, '_')
}

function canonicalSemantic(raw: string): string {
  const key = normalize(raw)
  return SEMANTIC_ALIASES[key] ?? key
}

function firstManifestHit(
  raw: string,
  semantic: string,
  emotionMap?: Record<string, string> | null,
): string | undefined {
  if (!emotionMap) return undefined
  const keys = [normalize(raw), semantic, SEMANTIC_ALIASES[normalize(raw)]].filter(Boolean)
  for (const key of keys) {
    if (emotionMap[key!]?.trim()) return key!
  }
  return undefined
}

export function adaptExpression(
  rawExpression: string,
  opts: {
    renderer: RendererKind
    intensity?: number
    emotionMap?: Record<string, string> | null
  },
): AdaptedExpression {
  const raw = normalize(rawExpression || 'neutral')
  const semantic = canonicalSemantic(raw || 'neutral')
  const intensity = clamp(typeof opts.intensity === 'number' ? opts.intensity : 1, 0, 1.4)

  if (opts.renderer === 'real2d') {
    const expression = REAL2D_EMOTIONS.has(semantic as Real2dEmotion)
      ? semantic
      : 'neutral'
    return {
      expression,
      intensity,
      semantic,
      fallbackUsed: expression !== raw,
    }
  }

  const manifestKey = firstManifestHit(raw, semantic, opts.emotionMap)
  if (manifestKey) {
    return {
      expression: manifestKey,
      intensity,
      semantic,
      fallbackUsed: manifestKey !== raw,
    }
  }

  return {
    expression: semantic,
    intensity,
    semantic,
    fallbackUsed: semantic !== raw,
  }
}
