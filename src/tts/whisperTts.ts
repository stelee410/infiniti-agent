import type { WhisperTtsConfig } from '../config/types.js'
import type { TtsEngine } from './engine.js'

const DEFAULT_MODEL = 'gpt-4o-mini-tts'
const DEFAULT_VOICE_ID = 'alloy'

export function createWhisperTts(cfg: WhisperTtsConfig): TtsEngine {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '')
  const model = cfg.model?.trim() || DEFAULT_MODEL
  const voice = cfg.voiceId?.trim() || DEFAULT_VOICE_ID

  return {
    async synthesize(text: string) {
      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          response_format: 'mp3',
        }),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`Whisper TTS ${res.status}: ${errText.slice(0, 500)}`)
      }

      const data = Buffer.from(await res.arrayBuffer())
      return { data, format: 'mp3' as const, sampleRate: 24000 }
    },
  }
}
