import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { loadConfig } from '../config/io.js'
import type { AsrConfig } from '../config/types.js'
import { createWhisperAsr, type AsrEngine } from '../asr/whisperAsr.js'
import { createSherpaOnnxAsr } from '../asr/sherpaOnnxAsr.js'
import {
  VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD,
} from '../liveui/voiceMicEnv.js'

export type TestAsrOptions = {
  /** 与 liveUi.voiceMicSpeechRmsThreshold 同量级 */
  rms: number
  /** 静音满多少毫秒后切段送 ASR */
  silenceMs: number
  /** 最短片段（毫秒），低于此丢弃不送识别 */
  minChunkMs: number
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function pcm16leMonoToWav(pcm: Buffer): Buffer {
  const sampleRate = 16000
  const channels = 1
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length
  const out = Buffer.allocUnsafe(44 + dataSize)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + dataSize, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(byteRate, 28)
  out.writeUInt16LE(blockAlign, 32)
  out.writeUInt16LE(bitsPerSample, 34)
  out.write('data', 36)
  out.writeUInt32LE(dataSize, 40)
  pcm.copy(out, 44)
  return out
}

async function createAsrFromConfig(cwd: string, asr: AsrConfig): Promise<AsrEngine> {
  if (asr.provider === 'whisper') {
    return createWhisperAsr(asr)
  }
  if (asr.provider === 'sherpa_onnx') {
    const model = resolve(cwd, asr.model)
    const tokens = resolve(cwd, asr.tokens)
    return createSherpaOnnxAsr({ ...asr, model, tokens })
  }
  throw new Error(`test_asr 暂不支持 ASR provider: ${(asr as { provider?: string }).provider}`)
}

/** 与 LiveUI 中 `vadRmsRelease` 一致思路 */
function releaseThreshold(speechRms: number): number {
  return Math.max(0.004, Math.min(speechRms * 0.48, speechRms - 1e-6))
}

/**
 * 构造 ffmpeg 从麦克风读 16kHz mono s16le 到 stdout 的参数（不含输出侧）。
 * 可用环境变量覆盖：
 * - `INFINITI_TEST_ASR_FFMPEG_INPUT`：空格分隔的「-f … -i …」片段，覆盖平台默认。
 */
function ffmpegInputArgs(): string[] {
  const custom = process.env.INFINITI_TEST_ASR_FFMPEG_INPUT?.trim()
  if (custom) {
    return custom.split(/\s+/).filter(Boolean)
  }
  switch (process.platform) {
    case 'darwin':
      return ['-f', 'avfoundation', '-i', 'none:0']
    case 'linux':
      return ['-f', 'alsa', '-i', 'default']
    case 'win32': {
      const mic = process.env.INFINITI_TEST_ASR_DSOUND_MIC ?? 'Microphone'
      return ['-f', 'dshow', '-i', `audio=${mic}`]
    }
    default:
      throw new Error(`test_asr: 不支持的平台 ${process.platform}，请设置 INFINITI_TEST_ASR_FFMPEG_INPUT`)
  }
}

/**
 * 麦克风 RMS 分段 + 调用项目 ASR，stdout 连续输出识别结果并以 `<停顿>` 连接。
 */
export async function runTestAsr(cwd: string, opts: TestAsrOptions): Promise<number> {
  const speechRms = clamp(opts.rms, 0.001, 0.35)
  const silenceMs = clamp(opts.silenceMs, 200, 12000)
  const minChunkMs = clamp(opts.minChunkMs, 80, 5000)
  const releaseRms = releaseThreshold(speechRms)
  const silenceSamples = Math.floor((silenceMs / 1000) * 16000)
  const minSamples = Math.floor((minChunkMs / 1000) * 16000)

  const cfg = await loadConfig(cwd)
  if (!cfg.asr) {
    console.error('test_asr: config.json 中未配置 asr（whisper 或 sherpa_onnx）。')
    process.exit(2)
  }

  const engine = await createAsrFromConfig(cwd, cfg.asr)

  console.error(
    `[test_asr] ASR=${cfg.asr.provider} · RMS=${speechRms} · release=${releaseRms.toFixed(4)} · 静音切段=${silenceMs}ms · 最短片段=${minChunkMs}ms`,
  )
  console.error('[test_asr] 开始从麦克风采集（需本机已安装 ffmpeg 并授予麦克风权限）。按 Ctrl+C 结束。')
  console.error(`[test_asr] ffmpeg 输入: ${ffmpegInputArgs().join(' ')} → 16kHz mono s16le`)

  const fifo: number[] = []
  const pushPcmS16le = (buf: Buffer): void => {
    for (let i = 0; i + 1 < buf.length; i += 2) {
      fifo.push(buf.readInt16LE(i))
      if (fifo.length > 8000) fifo.splice(0, fifo.length - 8000)
    }
  }

  const windowRms512 = (): number => {
    if (fifo.length < 512) return 0
    const start = fifo.length - 512
    let sum = 0
    for (let i = 0; i < 512; i++) {
      const x = fifo[start + i]! / 32768
      sum += x * x
    }
    return Math.sqrt(sum / 512)
  }

  let ff: ChildProcess | null = null
  let chain: Promise<void> = Promise.resolve()
  const inputArgs = ffmpegInputArgs()
  ff = spawn(
    'ffmpeg',
    [
      '-nostats',
      '-loglevel',
      'error',
      ...inputArgs,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      's16le',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let voiced = false
  let speechStreak = 0
  let belowReleaseStreakSamples = 0
  const segmentChunks: Buffer[] = []
  let segmentBytes = 0

  const flushSegment = async (): Promise<void> => {
    if (segmentBytes < minSamples * 2) {
      segmentChunks.length = 0
      segmentBytes = 0
      return
    }
    const pcm = Buffer.concat(segmentChunks)
    segmentChunks.length = 0
    segmentBytes = 0
    const wav = pcm16leMonoToWav(pcm)
    try {
      const text = (await engine.transcribe(wav, 'wav')).trim()
      if (text) {
        process.stdout.write(text)
        process.stdout.write('<停顿>')
      }
    } catch (e) {
      console.error(`\n[test_asr] 识别失败: ${(e as Error).message}`)
    }
  }

  const onPcmChunk = async (buf: Buffer): Promise<void> => {
    pushPcmS16le(buf)
    const rms = windowRms512()

    if (!voiced) {
      if (rms > speechRms) speechStreak += 1
      else speechStreak = 0
      if (speechStreak >= 3) {
        voiced = true
        speechStreak = 0
        belowReleaseStreakSamples = 0
        segmentChunks.push(buf)
        segmentBytes += buf.length
      }
      return
    }

    segmentChunks.push(buf)
    segmentBytes += buf.length

    if (rms > releaseRms) {
      belowReleaseStreakSamples = 0
    } else {
      belowReleaseStreakSamples += buf.length / 2
      if (belowReleaseStreakSamples >= silenceSamples) {
        voiced = false
        speechStreak = 0
        belowReleaseStreakSamples = 0
        await flushSegment()
      }
    }
  }

  ff.stdout?.on('data', (chunk: Buffer) => {
    chain = chain.then(() => onPcmChunk(chunk))
  })

  ff.stderr?.on('data', (d: Buffer) => {
    console.error(`[ffmpeg] ${d.toString('utf8').trimEnd()}`)
  })

  const killFfmpeg = (): void => {
    if (ff && !ff.killed) {
      ff.kill('SIGTERM')
    }
    ff = null
  }

  let sigRequested = false
  const onSig = (): void => {
    sigRequested = true
    killFfmpeg()
  }

  return await new Promise<number>((resolvePromise, rejectPromise) => {
    ff?.on('error', (err) => {
      console.error(
        `[test_asr] 无法启动 ffmpeg: ${(err as Error).message}\n` +
          '请确认已安装 ffmpeg，并在 macOS / Linux / Windows 上授予麦克风权限；' +
          '必要时设置 INFINITI_TEST_ASR_FFMPEG_INPUT 自定义输入设备参数。',
      )
      rejectPromise(err)
    })
    ff?.on('close', (code) => {
      void chain
        .then(async () => {
          if (voiced && segmentBytes >= minSamples * 2) {
            voiced = false
            await flushSegment()
          }
          if (!sigRequested && code !== 0 && code !== null && code !== 255) {
            console.error(`\n[test_asr] ffmpeg 退出码: ${code}`)
          }
          process.stdout.write('\n')
          const ec =
            sigRequested || code === 0 || code === null || code === 255 ? 0 : (code ?? 1)
          resolvePromise(ec)
        })
        .catch(rejectPromise)
    })

    process.once('SIGINT', onSig)
    process.once('SIGTERM', onSig)
  })
}

export function parseTestAsrRms(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    console.error(`test_asr: 无效 --rms: ${raw}`)
    process.exit(2)
  }
  return n
}

export function parseTestAsrInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  lo: number,
  hi: number,
): number {
  const n = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isFinite(n)) {
    console.error(`test_asr: 无效 ${name}: ${raw}`)
    process.exit(2)
  }
  return clamp(Math.round(n), lo, hi)
}
