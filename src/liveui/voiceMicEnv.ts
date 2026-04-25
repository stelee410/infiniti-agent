import type { LiveUiConfig } from '../config/types.js'

/** 历史硬编码 RMS 阈值（偏灵敏） */
export const VOICE_MIC_LEGACY_SPEECH_RMS_THRESHOLD = 0.015

/** 未在 config 中指定时的默认：较旧值提高约 30%，减少环境噪声误触发 */
export const VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD =
  Math.round(VOICE_MIC_LEGACY_SPEECH_RMS_THRESHOLD * 130) / 100

export const VOICE_MIC_DEFAULT_SILENCE_END_MS = 1500

/** TTS 播放期间不因麦克 RMS 发送 INTERRUPT，减轻扬声器串音误打断 */
export const VOICE_MIC_DEFAULT_SUPPRESS_INTERRUPT_DURING_TTS = true

export type LiveUiVoiceMicWire = {
  speechRmsThreshold: number
  silenceEndMs: number
  suppressInterruptDuringTts: boolean
  mode: 'push_to_talk' | 'auto'
}

/**
 * 供 `infiniti-agent live` 写入环境变量 `INFINITI_LIVEUI_VOICE_MIC`（JSON），
 * 由 Electron preload 注入 `window.infinitiLiveUi.voiceMic`。
 */
export function buildLiveUiVoiceMicEnvJson(
  lu?: LiveUiConfig,
  opts: { auto?: boolean } = {},
): string {
  const speech =
    typeof lu?.voiceMicSpeechRmsThreshold === 'number' &&
    Number.isFinite(lu.voiceMicSpeechRmsThreshold) &&
    lu.voiceMicSpeechRmsThreshold > 0
      ? Math.min(0.35, Math.max(0.001, lu.voiceMicSpeechRmsThreshold))
      : VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD
  const silence =
    typeof lu?.voiceMicSilenceEndMs === 'number' && Number.isFinite(lu.voiceMicSilenceEndMs)
      ? Math.min(12000, Math.max(200, Math.round(lu.voiceMicSilenceEndMs)))
      : VOICE_MIC_DEFAULT_SILENCE_END_MS
  const suppress =
    lu?.voiceMicSuppressInterruptDuringTts !== false
  const wire: LiveUiVoiceMicWire = {
    speechRmsThreshold: speech,
    silenceEndMs: silence,
    suppressInterruptDuringTts: suppress,
    mode: opts.auto ? 'auto' : 'push_to_talk',
  }
  return JSON.stringify(wire)
}
