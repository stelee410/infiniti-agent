import { readFile } from 'fs/promises'
import { extname, resolve } from 'path'
import type { MimoTtsConfig } from '../config/types.js'
import type { TtsAudioFormat, TtsEngine } from './engine.js'

const DEFAULT_VOICE_ID = 'mimo_default'
const DEFAULT_CONTROL = '自然、清晰、语速适中。'

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function audioMimeFromPath(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.mp3') return 'audio/mp3'
  return 'audio/wav'
}

function normalizeReferenceAudioBase64(value: string, mime = 'audio/wav'): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('data:audio/')) return trimmed
  return `data:${mime};base64,${trimmed}`
}

async function resolveVoice(cfg: MimoTtsConfig, cwd: string): Promise<string | undefined> {
  if (cfg.referenceAudioBase64?.trim()) {
    return normalizeReferenceAudioBase64(cfg.referenceAudioBase64)
  }
  if (cfg.referenceAudioPath?.trim()) {
    const path = resolve(cwd, cfg.referenceAudioPath.trim())
    const data = await readFile(path)
    return normalizeReferenceAudioBase64(data.toString('base64'), audioMimeFromPath(path))
  }
  if (cfg.model === 'mimo-v2.5-tts-voiceclone') {
    throw new Error('MiMo VoiceClone TTS 需要配置 referenceAudioPath 或 referenceAudioBase64')
  }
  if (cfg.model === 'mimo-v2.5-tts-voicedesign') return undefined
  return cfg.voiceId?.trim() || DEFAULT_VOICE_ID
}

export function createMimoTts(cfg: MimoTtsConfig, cwd: string): TtsEngine {
  const baseUrl = trimBaseUrl(cfg.baseUrl)
  const format = cfg.format ?? 'wav'
  const sampleRate = 24000
  const timeoutMs = cfg.timeoutMs ?? 120000

  return {
    async synthesize(text: string) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const voice = await resolveVoice(cfg, cwd)

      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: 'user', content: cfg.controlInstruction?.trim() || DEFAULT_CONTROL },
              { role: 'assistant', content: text },
            ],
            audio: {
              format,
              ...(voice ? { voice } : {}),
            },
            max_completion_tokens: 8192,
            temperature: 0.6,
          }),
        })

        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          throw new Error(`MiMo TTS ${res.status}: ${errText.slice(0, 500)}`)
        }

        const json = (await res.json()) as {
          choices?: Array<{ message?: { audio?: { data?: string } } }>
        }
        const audio = json.choices?.[0]?.message?.audio?.data
        if (!audio) throw new Error('MiMo TTS 响应中没有 audio.data')

        return {
          data: Buffer.from(audio, 'base64'),
          format: format as TtsAudioFormat,
          sampleRate,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
