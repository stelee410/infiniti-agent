import { spawn } from 'child_process'
import { appendMemoryEntry } from '../memory/store.js'
import type { BuiltinToolName } from './definitions.js'
import type { EditHistory } from '../session/editHistory.js'
import {
  toolGlobFiles,
  toolGrepFiles,
  toolListDirectory,
  toolReadFile,
  toolStrReplace,
  toolWriteFile,
} from './repoTools.js'

const MAX_HTTP_BODY_READ = 512 * 1024
const MAX_BASH_OUT = 512 * 1024

/** 与 ref/WebFetchTool 类似：部分站点会拒绝空 UA 或 Node 默认 UA */
const HTTP_DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'text/markdown, text/html, application/json, text/plain, */*;q=0.8',
  'User-Agent': `infiniti-agent/0.1.1 (Node.js ${process.version}; builtin http_request)`,
}

export type ToolRunContext = {
  sessionCwd: string
  editHistory?: EditHistory
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s
  }
  return `${s.slice(0, max)}\n\n…(输出已截断，共 ${s.length} 字符)`
}

async function runHttpRequest(args: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}): Promise<string> {
  const method = args.method.toUpperCase()
  const url = args.url.trim()
  if (!/^https?:\/\//i.test(url)) {
    return JSON.stringify({ ok: false, error: '仅允许 http/https URL' })
  }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return JSON.stringify({ ok: false, error: 'URL 无效' })
  }
  const host = u.hostname
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local')
  ) {
    return JSON.stringify({
      ok: false,
      error: '已阻止访问本地回环地址，请使用显式隧道或代理',
    })
  }

  /** ref/WebFetchTool/utils.ts 主请求 60s；此处默认略放宽以便大页面 */
  const timeoutMs = Math.min(
    120_000,
    Math.max(1000, args.timeoutMs ?? 60_000),
  )
  const ac = new AbortController()
  const deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const armTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
    }
    const ms = Math.max(1, deadline - Date.now())
    timer = setTimeout(() => ac.abort(), ms)
  }
  armTimer()
  const headers: Record<string, string> = {
    ...HTTP_DEFAULT_HEADERS,
    ...(args.headers ?? {}),
  }
  try {
    const res = await fetch(url, {
      method,
      headers,
      body:
        args.body && !['GET', 'HEAD'].includes(method)
          ? args.body
          : undefined,
      signal: ac.signal,
    })
    const ct = res.headers.get('content-type') ?? ''
    // 单一截止时间覆盖「首包 + 读 body」，语义接近 ref 里 axios 的整段 timeout
    armTimer()
    const buf = await res.arrayBuffer()
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    const slice = buf.byteLength > MAX_HTTP_BODY_READ
      ? buf.slice(0, MAX_HTTP_BODY_READ)
      : buf
    let text: string
    try {
      text = new TextDecoder('utf8', { fatal: false }).decode(slice)
    } catch {
      text = `[binary ${slice.byteLength} bytes]`
    }
    return JSON.stringify({
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: ct,
      bodyPreview: truncate(text, MAX_HTTP_BODY_READ),
    })
  } catch (e: unknown) {
    const err = e as Error
    return JSON.stringify({
      ok: false,
      error:
        err.name === 'AbortError'
          ? '请求超时（含连接与读 body，可用 timeoutMs 调整）'
          : err.message,
    })
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function runSpawn(
  cmd: string,
  cmdArgs: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd,
      env: process.env,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    const onData = (b: Buffer, which: 'stdout' | 'stderr') => {
      const chunk = b.toString('utf8')
      if (which === 'stdout') {
        stdout += chunk
        if (stdout.length > MAX_BASH_OUT) {
          child.kill('SIGKILL')
        }
      } else {
        stderr += chunk
        if (stderr.length > MAX_BASH_OUT) {
          child.kill('SIGKILL')
        }
      }
    }
    child.stdout?.on('data', (d) => onData(d, 'stdout'))
    child.stderr?.on('data', (d) => onData(d, 'stderr'))
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: truncate(stdout, MAX_BASH_OUT),
        stderr: truncate(stderr, MAX_BASH_OUT),
        code,
      })
    })
  })
}

async function runBash(
  command: string,
  cwd: string,
  timeoutMs?: number,
): Promise<string> {
  const t = Math.min(600_000, Math.max(1000, timeoutMs ?? 120_000))
  const c = command.trim()
  if (!c) {
    return JSON.stringify({ ok: false, error: '空命令' })
  }
  try {
    if (process.platform === 'win32') {
      const r = await runSpawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', c],
        cwd,
        t,
      )
      return JSON.stringify({
        ok: r.code === 0,
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
      })
    }
    const r = await runSpawn('bash', ['-lc', c], cwd, t)
    return JSON.stringify({
      ok: r.code === 0,
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
    })
  } catch (e: unknown) {
    const err = e as Error
    return JSON.stringify({ ok: false, error: err.message })
  }
}

export async function runBuiltinTool(
  name: BuiltinToolName,
  argsJson: string,
  ctx: ToolRunContext,
): Promise<string> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return JSON.stringify({ ok: false, error: '工具参数不是合法 JSON' })
  }

  if (name === 'http_request') {
    return runHttpRequest({
      method: String(args.method ?? 'GET'),
      url: String(args.url ?? ''),
      headers:
        args.headers && typeof args.headers === 'object'
          ? (args.headers as Record<string, string>)
          : undefined,
      body: args.body != null ? String(args.body) : undefined,
      timeoutMs:
        typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
    })
  }

  if (name === 'bash') {
    const cwd =
      typeof args.cwd === 'string' && args.cwd.trim()
        ? args.cwd.trim()
        : ctx.sessionCwd
    return runBash(String(args.command ?? ''), cwd, args.timeoutMs as number)
  }

  if (name === 'update_memory') {
    const body = String(args.body ?? '')
    if (!body.trim()) {
      return JSON.stringify({ ok: false, error: 'body 不能为空' })
    }
    await appendMemoryEntry(ctx.sessionCwd, {
      title: args.title != null ? String(args.title) : undefined,
      body,
    })
    return JSON.stringify({ ok: true, message: '已写入长期记忆文件' })
  }

  if (name === 'read_file') {
    return toolReadFile(ctx.sessionCwd, args)
  }
  if (name === 'list_directory') {
    return toolListDirectory(ctx.sessionCwd, args)
  }
  if (name === 'glob_files') {
    return toolGlobFiles(ctx.sessionCwd, args)
  }
  if (name === 'grep_files') {
    return toolGrepFiles(ctx.sessionCwd, args)
  }
  if (name === 'write_file') {
    return toolWriteFile(ctx.sessionCwd, args, {
      editHistory: ctx.editHistory,
    })
  }
  if (name === 'str_replace') {
    return toolStrReplace(ctx.sessionCwd, args, {
      editHistory: ctx.editHistory,
    })
  }

  return JSON.stringify({ ok: false, error: '未知内置工具' })
}
