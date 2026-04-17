import type { TtsConfig } from '../config/types.js'

const DEFAULT_MODEL = 'speech-02-turbo'
const DEFAULT_VOICE_ID = 'female-shaonv'

export interface TtsEngine {
  /** 将文本合成为 mp3 Buffer；调用方负责排队。 */
  synthesize(text: string): Promise<Buffer>
}

export function createMinimaxTts(cfg: TtsConfig): TtsEngine {
  const model = cfg.model ?? DEFAULT_MODEL
  const voiceId = cfg.voiceId ?? DEFAULT_VOICE_ID
  const speed = cfg.speed ?? 1.0
  const vol = cfg.vol ?? 1.0
  const pitch = cfg.pitch ?? 0
  const endpoint = `https://api.minimax.chat/v1/t2a_v2?GroupId=${cfg.groupId}`

  return {
    async synthesize(text: string): Promise<Buffer> {
      const body = {
        model,
        text,
        stream: true,
        voice_setting: {
          voice_id: voiceId,
          speed,
          vol,
          pitch,
        },
        pronunciation_dict: { tone: [] },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
          channel: 1,
        },
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`MiniMax TTS ${res.status}: ${errText.slice(0, 500)}`)
      }

      if (!res.body) {
        throw new Error('MiniMax TTS: 无响应体')
      }

      const chunks: Buffer[] = []
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let lineBuf = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        lineBuf += decoder.decode(value, { stream: true })

        let nlIdx: number
        while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nlIdx).trim()
          lineBuf = lineBuf.slice(nlIdx + 1)
          if (!line.startsWith('data:')) continue
          try {
            const json = JSON.parse(line.slice(5)) as {
              data?: { audio?: string }
              extra_info?: unknown
              base_resp?: { status_code?: number; status_msg?: string }
            }
            if (json.base_resp && json.base_resp.status_code !== 0) {
              throw new Error(`MiniMax TTS API error ${json.base_resp.status_code}: ${json.base_resp.status_msg ?? ''}`)
            }
            if (json.data && !json.extra_info && json.data.audio) {
              chunks.push(Buffer.from(json.data.audio, 'hex'))
            }
          } catch (e) {
            if (e instanceof Error && e.message.startsWith('MiniMax TTS API')) throw e
          }
        }
      }

      // 处理非 SSE 格式的错误响应（MiniMax 有时返回 HTTP 200 + 纯 JSON 错误）
      if (chunks.length === 0 && lineBuf.trim()) {
        try {
          const errJson = JSON.parse(lineBuf.trim()) as { base_resp?: { status_code?: number; status_msg?: string } }
          if (errJson.base_resp && errJson.base_resp.status_code !== 0) {
            throw new Error(`MiniMax TTS API error ${errJson.base_resp.status_code}: ${errJson.base_resp.status_msg ?? ''}`)
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('MiniMax TTS API')) throw e
        }
      }

      return Buffer.concat(chunks)
    },
  }
}
