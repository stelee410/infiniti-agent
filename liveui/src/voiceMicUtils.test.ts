import { describe, expect, it } from 'vitest'
import {
  VAD_FFT_SIZE,
  computeVadFrame,
  resolveVoiceMicWire,
} from './voiceMicUtils.ts'

function freqWithSpeechBand(value: number, outside = 2): Uint8Array {
  const freq = new Uint8Array(VAD_FFT_SIZE / 2)
  freq.fill(outside)
  for (let i = 4; i < 36; i++) {
    freq[i] = value
  }
  return freq
}

describe('resolveVoiceMicWire', () => {
  it('normalizes missing and out-of-range voice mic configuration', () => {
    expect(resolveVoiceMicWire({ speechRmsThreshold: -1, silenceEndMs: 1, mode: 'push_to_talk' })).toEqual(
      expect.objectContaining({
        silenceEndMs: 200,
        mode: 'push_to_talk',
        ttsAutoEnabled: true,
        asrAutoEnabled: false,
      }),
    )
    expect(resolveVoiceMicWire({
      speechRmsThreshold: 9,
      silenceEndMs: 99_999,
      suppressInterruptDuringTts: false,
      mode: 'auto',
      ttsAutoEnabled: false,
      asrAutoEnabled: true,
    })).toEqual({
      speechRmsThreshold: 0.35,
      silenceEndMs: 12000,
      suppressInterruptDuringTts: false,
      mode: 'auto',
      ttsAutoEnabled: false,
      asrAutoEnabled: true,
    })
  })
})

describe('computeVadFrame', () => {
  it('accepts voiced frames with concentrated speech-band energy', () => {
    const result = computeVadFrame({
      timeDomain: new Float32Array(VAD_FFT_SIZE).fill(0.08),
      freqBytes: freqWithSpeechBand(180),
      sampleRate: 16_000,
      speechRmsThreshold: 0.03,
      noiseSpeechBandEma: 1e-10,
    })

    expect(result.rms).toBeCloseTo(0.08)
    expect(result.spectralOk).toBe(true)
  })

  it('rejects wideband flat noise even when RMS is high', () => {
    const freq = new Uint8Array(VAD_FFT_SIZE / 2)
    freq.fill(120)

    const result = computeVadFrame({
      timeDomain: new Float32Array(VAD_FFT_SIZE).fill(0.08),
      freqBytes: freq,
      sampleRate: 16_000,
      speechRmsThreshold: 0.03,
      noiseSpeechBandEma: 1e-10,
    })

    expect(result.spectralOk).toBe(false)
  })

  it('updates the speech-band noise floor on quiet frames', () => {
    const result = computeVadFrame({
      timeDomain: new Float32Array(VAD_FFT_SIZE).fill(0.001),
      freqBytes: freqWithSpeechBand(20),
      sampleRate: 16_000,
      speechRmsThreshold: 0.03,
      noiseSpeechBandEma: 1e-10,
    })

    expect(result.noiseSpeechBandEma).toBeGreaterThan(1e-10)
  })
})
