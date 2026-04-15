import type { WhisperAsrConfig } from '../config/types.js'

const DEFAULT_MODEL = 'whisper-large-v3-turbo'

export interface AsrEngine {
  transcribe(audioBuffer: Buffer, format: string): Promise<string>
}

/**
 * OpenAI-compatible Whisper ASR 引擎。
 * 兼容 Groq / OpenAI / 任何支持 /v1/audio/transcriptions 的服务。
 */
export function createWhisperAsr(cfg: WhisperAsrConfig): AsrEngine {
  const model = cfg.model ?? DEFAULT_MODEL
  const lang = cfg.lang ?? ''
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`

  return {
    async transcribe(audioBuffer: Buffer, format: string): Promise<string> {
      const ext = format === 'webm' ? 'webm' : 'wav'
      const mime = format === 'webm' ? 'audio/webm' : 'audio/wav'

      const formData = new FormData()
      formData.append('file', new Blob([audioBuffer], { type: mime }), `audio.${ext}`)
      formData.append('model', model)
      formData.append('response_format', 'text')
      if (lang) formData.append('language', lang)
      formData.append('temperature', '0')

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: formData,
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`Whisper ASR ${res.status}: ${errText.slice(0, 500)}`)
      }

      const text = await res.text()
      return text.trim()
    },
  }
}
