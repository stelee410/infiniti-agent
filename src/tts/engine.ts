/** TTS 单句结果；LiveUI 按 format 解码（wav/mp3 走 decodeAudioData，pcm_s16le 走手动填 Buffer）。 */
export type TtsAudioFormat = 'mp3' | 'wav' | 'pcm_s16le'

export type TtsSynthesisResult = {
  data: Buffer
  format: TtsAudioFormat
  sampleRate: number
  /** pcm_s16le 时声道数（MOSS 流式多为 2） */
  channels?: number
}

export type TtsStreamEmit = (chunk: TtsSynthesisResult) => void | Promise<void>

export interface TtsEngine {
  /** 将文本合成为一整段音频（MiniMax 等）；与 synthesizeStream 二选一或并存。 */
  synthesize(text: string): Promise<TtsSynthesisResult>
  /**
   * MOSS `/api/generate-stream`：边收 PCM 边回调；LiveUi 逐块下发 AUDIO_CHUNK。
   * 若存在，wsSession 优先走本路径以实现低延迟。
   */
  synthesizeStream?(text: string, emit: TtsStreamEmit): Promise<void>
}
