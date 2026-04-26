import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { localAgentDir } from '../paths.js'

type WriteFn = typeof process.stderr.write

let restoreStack: Array<() => void> = []
let activePath: string | null = null
let activeDepth = 0

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack ?? a.message
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

function appendLog(logPath: string, text: string): void {
  const s = text.endsWith('\n') ? text : `${text}\n`
  appendFileSync(logPath, s, 'utf8')
}

function chunkToString(chunk: unknown, encoding?: BufferEncoding): string {
  if (Buffer.isBuffer(chunk)) return chunk.toString(encoding ?? 'utf8')
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding ?? 'utf8')
  return String(chunk)
}

export function uiLogPath(cwd: string): string {
  return `${localAgentDir(cwd)}/infiniti-agent.log`
}

export function enableUiLogFile(cwd: string): string {
  if (activePath) {
    activeDepth += 1
    return activePath
  }

  const logPath = uiLogPath(cwd)
  mkdirSync(dirname(logPath), { recursive: true })
  appendLog(logPath, `\n--- ui session start ${new Date().toISOString()} cwd=${cwd} ---`)

  const originalError = console.error
  const originalWarn = console.warn
  const originalLog = console.log
  const originalStderrWrite = process.stderr.write.bind(process.stderr) as WriteFn

  console.error = (...args: unknown[]) => appendLog(logPath, formatArgs(args))
  console.warn = (...args: unknown[]) => appendLog(logPath, formatArgs(args))
  console.log = (...args: unknown[]) => appendLog(logPath, formatArgs(args))

  const stderrWrite: WriteFn = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb as BufferEncoding : undefined
    appendLog(logPath, chunkToString(chunk, encoding))
    const done = typeof encodingOrCb === 'function' ? encodingOrCb : cb
    if (typeof done === 'function') queueMicrotask(() => done())
    return true
  }) as WriteFn
  process.stderr.write = stderrWrite

  activePath = logPath
  activeDepth = 1
  restoreStack.push(() => {
    console.error = originalError
    console.warn = originalWarn
    console.log = originalLog
    process.stderr.write = originalStderrWrite
    appendLog(logPath, `--- ui session end ${new Date().toISOString()} ---`)
    activePath = null
    activeDepth = 0
  })
  return logPath
}

export function disableUiLogFile(): void {
  if (activeDepth > 1) {
    activeDepth -= 1
    return
  }
  const restore = restoreStack.pop()
  if (restore) restore()
}

export async function withUiLogFile<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  enableUiLogFile(cwd)
  try {
    return await run()
  } finally {
    disableUiLogFile()
  }
}
