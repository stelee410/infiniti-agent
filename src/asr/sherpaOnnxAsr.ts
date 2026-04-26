import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SherpaOnnxAsrConfig } from '../config/types.js'
import type { AsrEngine } from './whisperAsr.js'

function resolveSherpaPath(p: string, cwd: string): string {
  const t = p.trim()
  return t && isAbsolute(t) ? t : resolve(cwd, t)
}

const TERMINAL_PUNCT_RE = /[。！？!?.,，；;：:、…]$/
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

function restoreLightPunctuation(text: string): string {
  const t = text.trim()
  if (!t || TERMINAL_PUNCT_RE.test(t)) return t
  return `${t}${CJK_RE.test(t) ? '。' : '.'}`
}

/**
 * 本地 sherpa-onnx SenseVoice ASR 引擎。
 * 用 ffmpeg 将 webm 转 16kHz mono WAV，再用 sherpa-onnx-node 离线识别。
 *
 * `cfg.model` / `cfg.tokens` 相对路径按 `cwd`（一般为项目根）解析，避免进程 cwd 与配置不一致时找不到 `./models/...`。
 */
export async function createSherpaOnnxAsr(cfg: SherpaOnnxAsrConfig, cwd = process.cwd()): Promise<AsrEngine> {
  const modelPath = resolveSherpaPath(cfg.model, cwd)
  const tokensPath = resolveSherpaPath(cfg.tokens, cwd)
  if (!existsSync(tokensPath)) {
    throw new Error(`sherpa-onnx: tokens 文件不存在: ${tokensPath}`)
  }
  if (!existsSync(modelPath)) {
    throw new Error(`sherpa-onnx: model 文件不存在: ${modelPath}`)
  }

  const imported = await import('sherpa-onnx-node')
  const sherpa = (imported as any).default ?? imported

  const recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: modelPath,
        useInverseTextNormalization: true,
        language: cfg.lang ?? 'auto',
      },
      tokens: tokensPath,
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
        return restoreLightPunctuation(result.text ?? '')
      } finally {
        try { unlinkSync(inputPath) } catch { /* ignore */ }
        try { unlinkSync(wavPath) } catch { /* ignore */ }
      }
    },
  }
}
