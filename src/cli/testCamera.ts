import { appendFileSync, existsSync, mkdirSync, statSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { captureVisionSnapshotResult } from '../liveui/visionCapture.js'

export type TestCameraOptions = {
  output?: string
  log?: string
  timeoutMs: number
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function tailFile(path: string, maxLines = 80): string {
  try {
    const lines = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/)
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}

function appendLog(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // test diagnostics should not break the camera attempt
  }
}

export function parseTestCameraInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 3000 || n > 120000) {
    console.error(`test_camera: 无效 ${name}: ${raw}（范围 3000..120000）`)
    process.exit(2)
  }
  return n
}

export async function runTestCamera(opts: TestCameraOptions): Promise<number> {
  const id = stamp()
  const output = opts.output?.trim() || join('/tmp', `infiniti-agent-camera-${id}.jpg`)
  const log = opts.log?.trim() || join('/tmp', `infiniti-agent-camera-${id}.log`)

  console.error('[test_camera] mode: CLI native camera backend')
  console.error(`[test_camera] output: ${output}`)
  console.error(`[test_camera] log: ${log}`)

  let code = 0
  const originalError = console.error
  const originalWarn = console.warn
  console.error = (...args: unknown[]) => {
    originalError(...args)
    appendLog(log, `[stderr] ${args.map(String).join(' ')}`)
  }
  console.warn = (...args: unknown[]) => {
    originalWarn(...args)
    appendLog(log, `[warn] ${args.map(String).join(' ')}`)
  }
  try {
    await mkdir(dirname(log), { recursive: true })
    await writeFile(log, `${new Date().toISOString()} [test_camera] start\n`, 'utf8')
    const result = await captureVisionSnapshotResult({ timeoutMs: opts.timeoutMs, logPath: log })
    if (!result.ok) {
      appendLog(log, `[test_camera] failed: ${result.error}`)
      console.error(`[test_camera] 拍照失败: ${result.error}`)
      code = 1
    } else {
      const image = Buffer.from(result.vision.imageBase64, 'base64')
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, image)
      appendLog(log, `[test_camera] ok: ${result.vision.mediaType}, ${image.length} bytes -> ${output}`)
      console.error(`[test_camera] 拍照成功: ${output} (${image.length} bytes)`)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    appendLog(log, `[test_camera] fatal: ${message}`)
    console.error(`[test_camera] 拍照异常: ${message}`)
    code = 1
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }

  if (existsSync(output)) {
    const size = statSync(output).size
    console.error(`[test_camera] 图片已生成: ${output} (${size} bytes)`)
  } else {
    console.error('[test_camera] 图片未生成')
  }

  const tail = tailFile(log)
  if (tail) {
    console.error(`[test_camera] 日志尾部 (${log}):\n${tail}`)
  } else {
    console.error(`[test_camera] 日志为空或不可读: ${log}`)
  }

  return code
}
