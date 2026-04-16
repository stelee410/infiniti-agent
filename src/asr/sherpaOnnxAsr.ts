import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SherpaOnnxAsrConfig } from '../config/types.js'
import type { AsrEngine } from './whisperAsr.js'

/**
 * 本地 sherpa-onnx SenseVoice ASR 引擎。
 * 用 ffmpeg 将 webm 转 16kHz mono WAV，再用 sherpa-onnx-node 离线识别。
 */
export async function createSherpaOnnxAsr(cfg: SherpaOnnxAsrConfig): Promise<AsrEngine> {
  const imported = await import('sherpa-onnx-node')
  const sherpa = (imported as any).default ?? imported

  const recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: cfg.model,
        useInverseTextNormalization: true,
        language: cfg.lang ?? 'auto',
      },
      tokens: cfg.tokens,
      numThreads: cfg.numThreads ?? 4,
      debug: false,
    },
  })

  console.error(`[asr] sherpa-onnx SenseVoice 已加载: model=${cfg.model}`)

  return {
    async transcribe(audioBuffer: Buffer, format: string): Promise<string> {
      const id = randomBytes(6).toString('hex')
      /* 输入与输出必须不同路径：format 为 wav 时若同名 ffmpeg 会报「cannot edit in-place」 */
      const inputPath = join(tmpdir(), `infiniti-asr-${id}-src.${format}`)
      const wavPath = join(tmpdir(), `infiniti-asr-${id}-norm.wav`)

      try {
        writeFileSync(inputPath, audioBuffer)

        execFileSync('ffmpeg', [
          '-y', '-i', inputPath,
          '-ar', '16000', '-ac', '1', '-f', 'wav',
          wavPath,
        ], { stdio: 'pipe', timeout: 15000 })

        const wave = sherpa.readWave(wavPath)
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
        recognizer.decode(stream)
        const result = recognizer.getResult(stream) as { text?: string }
        return (result.text ?? '').trim()
      } finally {
        try { unlinkSync(inputPath) } catch { /* ignore */ }
        try { unlinkSync(wavPath) } catch { /* ignore */ }
      }
    },
  }
}
