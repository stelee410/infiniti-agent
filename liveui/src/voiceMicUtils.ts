import type { LiveUiVoiceMicWire } from '../../src/liveui/voiceMicEnv.ts'
import {
  VOICE_MIC_DEFAULT_SILENCE_END_MS,
  VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD,
  VOICE_MIC_DEFAULT_SUPPRESS_INTERRUPT_DURING_TTS,
} from '../../src/liveui/voiceMicEnv.ts'

export const VAD_FFT_SIZE = 512
export const VAD_SPEECH_FMIN = 300
export const VAD_SPEECH_FMAX = 3400
export const VAD_MIN_SPEECH_BAND_RATIO = 0.33
export const VAD_MAX_SPEECH_FLATNESS = 0.62
export const VAD_NOISE_EMA = 0.06
export const VAD_MIN_SPEECH_TO_NOISE = 2.0

export type VadFrameInput = {
  timeDomain: Float32Array
  freqBytes: Uint8Array
  sampleRate: number
  fftSize?: number
  speechRmsThreshold: number
  noiseSpeechBandEma: number
}

export type VadFrameResult = {
  rms: number
  spectralOk: boolean
  noiseSpeechBandEma: number
}

export function resolveVoiceMicWire(vm?: Partial<LiveUiVoiceMicWire>): LiveUiVoiceMicWire {
  const speech =
    typeof vm?.speechRmsThreshold === 'number' &&
    Number.isFinite(vm.speechRmsThreshold) &&
    vm.speechRmsThreshold > 0
      ? Math.min(0.35, Math.max(0.001, vm.speechRmsThreshold))
      : VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD
  const silence =
    typeof vm?.silenceEndMs === 'number' && Number.isFinite(vm.silenceEndMs)
      ? Math.min(12000, Math.max(200, Math.round(vm.silenceEndMs)))
      : VOICE_MIC_DEFAULT_SILENCE_END_MS
  const suppress =
    vm?.suppressInterruptDuringTts === false
      ? false
      : VOICE_MIC_DEFAULT_SUPPRESS_INTERRUPT_DURING_TTS
  const mode = vm?.mode === 'auto' ? 'auto' : 'push_to_talk'
  return {
    speechRmsThreshold: speech,
    silenceEndMs: silence,
    suppressInterruptDuringTts: suppress,
    mode,
    ttsAutoEnabled: vm?.ttsAutoEnabled !== false,
    asrAutoEnabled: vm?.asrAutoEnabled === true,
  }
}

export function computeVadFrame(input: VadFrameInput): VadFrameResult {
  let sumSq = 0
  for (let i = 0; i < input.timeDomain.length; i++) {
    const s = input.timeDomain[i]!
    sumSq += s * s
  }
  const rms = Math.sqrt(sumSq / input.timeDomain.length)
  const n = input.freqBytes.length
  const fftSize = input.fftSize ?? VAD_FFT_SIZE
  const binFromHz = (hz: number) => Math.floor((hz * fftSize) / input.sampleRate)
  const start = Math.max(1, binFromHz(VAD_SPEECH_FMIN))
  const end = Math.min(n - 1, binFromHz(VAD_SPEECH_FMAX))
  if (end <= start) return { rms, spectralOk: true, noiseSpeechBandEma: input.noiseSpeechBandEma }

  let totalPow = 0
  for (let i = 1; i < n; i++) {
    const v = input.freqBytes[i]! / 255
    totalPow += v * v
  }
  if (totalPow < 1e-8) return { rms, spectralOk: false, noiseSpeechBandEma: input.noiseSpeechBandEma }

  let speechPow = 0
  let logSum = 0
  const bandBins = end - start + 1
  for (let i = start; i <= end; i++) {
    const v = input.freqBytes[i]! / 255
    const p = v * v + 1e-12
    speechPow += p
    logSum += Math.log(p)
  }
  const amean = speechPow / bandBins
  const gmean = Math.exp(logSum / bandBins)
  const flatness = amean > 0 ? gmean / amean : 1
  if (!Number.isFinite(flatness)) return { rms, spectralOk: false, noiseSpeechBandEma: input.noiseSpeechBandEma }

  const bandRatio = speechPow / totalPow
  const ratioOk = bandRatio >= VAD_MIN_SPEECH_BAND_RATIO
  const flatOk = flatness <= VAD_MAX_SPEECH_FLATNESS

  let nextNoise = input.noiseSpeechBandEma
  if (rms < input.speechRmsThreshold * 0.55) {
    nextNoise = (1 - VAD_NOISE_EMA) * nextNoise + VAD_NOISE_EMA * speechPow
  }
  const snrOk = speechPow >= VAD_MIN_SPEECH_TO_NOISE * nextNoise || nextNoise < 1e-6

  return {
    rms,
    spectralOk: ratioOk && flatOk && snrOk,
    noiseSpeechBandEma: nextNoise,
  }
}
