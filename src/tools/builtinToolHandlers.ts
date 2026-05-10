import { spawn } from 'child_process'
import { isIP } from 'node:net'
import { appendMemoryEntry } from '../memory/store.js'
import { executeMemoryAction, type MemoryAction, type MemoryTag } from '../memory/structured.js'
import { executeProfileAction, type ProfileAction, type ProfileTag } from '../memory/userProfile.js'
import { searchSessions, type SearchResult } from '../session/archive.js'
import { executeSkillAction, type SkillAction } from '../skills/manager.js'
import { executeKgAction, type KgAction } from '../memory/knowledgeGraph.js'
import {
  addScheduleTask,
  clearCompletedScheduleTasks,
  formatScheduleTask,
  loadScheduleStore,
  nextDailyRun,
  removeScheduleTask,
  type ScheduleKind,
} from '../schedule/store.js'
import { enqueueSnapPhotoJob } from '../snap/asyncSnap.js'
import { enqueueSeedanceVideoJob } from '../video/asyncVideo.js'
import { enqueueAvatarGenJob } from '../avatar/asyncAvatarGen.js'
import type { BuiltinToolName } from './definitions.js'
import { H5AppletValidator, normalizePermissions, type H5AppletLaunchMode, type H5AppletPatchType, type H5AppletPermissions } from '../liveui/appletRuntime.js'
import {
  deleteCachedH5Applet,
  findCachedH5Applet,
  generateH5AppletHtml,
  h5AppletCacheKey,
  listCachedH5Applets,
  readCachedH5Applet,
  writeCachedH5Applet,
} from '../liveui/h5AppletCache.js'
import {
  toolGlobFiles,
  toolGrepFiles,
  toolListDirectory,
  toolReadFile,
  toolStrReplace,
  toolWriteFile,
} from './repoTools.js'
import { resolveWorkspacePath } from './workspacePaths.js'
import type { ToolRunContext } from './runner.js'

const MAX_HTTP_BODY_READ = 512 * 1024
const MAX_BASH_OUT = 512 * 1024

const HTTP_DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'text/markdown, text/html, application/json, text/plain, */*;q=0.8',
  'User-Agent': `infiniti-agent/0.1.1 (Node.js ${process.version}; builtin http_request)`,
}

type ToolArgs = Record<string, unknown>
type ToolHandler = (args: ToolArgs, ctx: ToolRunContext) => Promise<string> | string

export function toolError(error: string): string {
  return JSON.stringify({ ok: false, error })
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n\n…(输出已截断，共 ${s.length} 字符)`
}

function blockedHttpHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return true
  }

  const ipVersion = isIP(host)
  if (ipVersion === 6) {
    return (
      host === '::1' ||
      host === '::' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80:')
    )
  }
  if (ipVersion !== 4) return false

  const parts = host.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false
  }
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
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
    return toolError('仅允许 http/https URL')
  }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return toolError('URL 无效')
  }
  if (blockedHttpHost(u.hostname)) {
    return toolError('已阻止访问本地、私网或 link-local 地址，请使用显式隧道或代理')
  }

  const timeoutMs = Math.min(120_000, Math.max(1000, args.timeoutMs ?? 60_000))
  const ac = new AbortController()
  const deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const armTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => ac.abort(), Math.max(1, deadline - Date.now()))
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
      body: args.body && !['GET', 'HEAD'].includes(method) ? args.body : undefined,
      signal: ac.signal,
    })
    const ct = res.headers.get('content-type') ?? ''
    armTimer()
    const buf = await res.arrayBuffer()
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    const slice = buf.byteLength > MAX_HTTP_BODY_READ ? buf.slice(0, MAX_HTTP_BODY_READ) : buf
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
    if (timer) clearTimeout(timer)
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
        if (stdout.length > MAX_BASH_OUT) child.kill('SIGKILL')
      } else {
        stderr += chunk
        if (stderr.length > MAX_BASH_OUT) child.kill('SIGKILL')
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

async function runBash(command: string, cwd: string, timeoutMs?: number): Promise<string> {
  const t = Math.min(600_000, Math.max(1000, timeoutMs ?? 120_000))
  const c = command.trim()
  if (!c) return toolError('空命令')
  try {
    if (process.platform === 'win32') {
      const r = await runSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', c], cwd, t)
      return JSON.stringify({ ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr })
    }
    const r = await runSpawn('bash', ['-lc', c], cwd, t)
    return JSON.stringify({ ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr })
  } catch (e: unknown) {
    const err = e as Error
    return toolError(err.message)
  }
}

function parseLaunchMode(raw: unknown): H5AppletLaunchMode | undefined {
  return raw === 'live_panel' || raw === 'floating' || raw === 'fullscreen' || raw === 'overlay'
    ? raw
    : undefined
}

function parsePatchType(raw: unknown): H5AppletPatchType | undefined {
  return raw === 'replace' || raw === 'css' || raw === 'state' ? raw : undefined
}

function parseAppletPermissions(raw: unknown): Partial<H5AppletPermissions> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  return {
    ...(typeof p.network === 'boolean' ? { network: p.network } : {}),
    ...(p.storage === false || p.storage === 'session' ? { storage: p.storage } : {}),
    ...(typeof p.microphone === 'boolean' ? { microphone: p.microphone } : {}),
    ...(typeof p.camera === 'boolean' ? { camera: p.camera } : {}),
    ...(typeof p.clipboard === 'boolean' ? { clipboard: p.clipboard } : {}),
    ...(typeof p.fullscreen === 'boolean' ? { fullscreen: p.fullscreen } : {}),
  }
}

function validateCachedAppletForLaunch(cached: {
  html: string
  permissions: Partial<H5AppletPermissions>
}): string | null {
  const validation = new H5AppletValidator().validateHtml(
    cached.html,
    normalizePermissions(cached.permissions),
  )
  return validation.ok ? null : validation.errors.join('; ')
}

export const builtinToolHandlers: Record<BuiltinToolName, ToolHandler> = {
  request_h5_applet: async (args, ctx) => {
    if (!ctx.liveUi) return toolError('LiveUI 未启动。请使用 `infiniti-agent live` 启动数字人窗口后再请求快应用。')
    const title = String(args.title ?? '').trim()
    const description = String(args.description ?? '').trim()
    const launchMode = parseLaunchMode(args.launch_mode) ?? 'live_panel'
    if (!title) return toolError('title 不能为空')

    const cached = await findCachedH5Applet(ctx.sessionCwd, title, description)
    const cachedError = cached ? validateCachedAppletForLaunch(cached) : null
    if (cached && !cachedError) {
      ctx.liveUi.sendH5AppletLibrary(await listCachedH5Applets(ctx.sessionCwd))
      ctx.liveUi.launchH5Applet(cached.key)
      return JSON.stringify({
        ok: true,
        cache: 'hit',
        key: cached.key,
        status: 'launch_requested',
        message: '本地已有缓存，已直接启动快应用。',
      })
    }
    if (cachedError) {
      ctx.liveUi.sendH5AppletGeneration({
        status: 'failed',
        title,
        description,
        key: cached?.key,
        error: `缓存未通过校验，已忽略并重新生成：${cachedError}`,
      })
    }

    const key = h5AppletCacheKey(title, description)
    ctx.liveUi.sendH5AppletGeneration({ status: 'started', title, description, key })
    void (async () => {
      try {
        const html = await generateH5AppletHtml({ config: ctx.config, title, description })
        const validation = new H5AppletValidator().validateHtml(
          html,
          normalizePermissions({ network: false, storage: 'session' }),
        )
        if (!validation.ok) throw new Error(`生成的快应用未通过安全校验：${validation.errors.join('; ')}`)
        const saved = await writeCachedH5Applet(ctx.sessionCwd, {
          key,
          title,
          description,
          launchMode,
          permissions: { network: false, storage: 'session' },
          html,
        })
        ctx.liveUi?.sendH5AppletGeneration({
          status: 'completed',
          title,
          description,
          key: saved.key,
        })
        ctx.liveUi?.sendH5AppletLibrary(await listCachedH5Applets(ctx.sessionCwd))
      } catch (e) {
        ctx.liveUi?.sendH5AppletGeneration({
          status: 'failed',
          title,
          description,
          key,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })()
    return JSON.stringify({
      ok: true,
      cache: 'miss',
      status: 'generating',
      key,
      message: '本地没有缓存，已交给 H5 子 agent 异步编写。完成后会出现在 LiveUI 的快应用图标栏，点击即可启动。',
    })
  },

  launch_h5_applet: async (args, ctx) => {
    if (!ctx.liveUi) return toolError('LiveUI 未启动，无法启动快应用。')
    const key = String(args.key ?? '').trim()
    const title = String(args.title ?? '').trim()
    const cached = key
      ? await readCachedH5Applet(ctx.sessionCwd, key)
      : title
        ? await findCachedH5Applet(ctx.sessionCwd, title)
        : null
    if (!cached) return toolError('未找到本地快应用缓存')
    const cachedError = validateCachedAppletForLaunch(cached)
    if (cachedError) return toolError(`本地快应用缓存未通过安全校验，请重新生成：${cachedError}`)
    ctx.liveUi.launchH5Applet(cached.key)
    return JSON.stringify({ ok: true, status: 'launch_requested', cache: 'hit', key: cached.key })
  },

  list_h5_applets: async (_args, ctx) => {
    const items = await listCachedH5Applets(ctx.sessionCwd)
    ctx.liveUi?.sendH5AppletLibrary(items)
    return JSON.stringify({ ok: true, count: items.length, items })
  },

  delete_h5_applet_cache: async (args, ctx) => {
    const key = String(args.key ?? '').trim()
    const title = String(args.title ?? '').trim()
    if (!key && !title) return toolError('请提供 key/id 或 title')
    const deleted = await deleteCachedH5Applet(ctx.sessionCwd, {
      keyOrId: key || undefined,
      title: title || undefined,
    })
    if (!deleted) return toolError('未找到本地快应用缓存')
    const items = await listCachedH5Applets(ctx.sessionCwd)
    ctx.liveUi?.sendH5AppletLibrary(items)
    return JSON.stringify({
      ok: true,
      deleted: {
        id: deleted.id,
        key: deleted.key,
        title: deleted.title,
      },
      count: items.length,
    })
  },

  create_h5_applet: (args, ctx) => {
    if (!ctx.liveUi) return toolError('LiveUI 未启动。请使用 `infiniti-agent live` 启动数字人窗口后再创建 H5 applet。')
    try {
      const applet = ctx.liveUi.createH5Applet({
        title: String(args.title ?? ''),
        description: args.description != null ? String(args.description) : undefined,
        launchMode: parseLaunchMode(args.launch_mode),
        permissions: parseAppletPermissions(args.permissions),
        html: String(args.html ?? ''),
      })
      void writeCachedH5Applet(ctx.sessionCwd, {
        title: applet.title,
        description: applet.description,
        launchMode: applet.launchMode,
        permissions: applet.permissions,
        html: String(args.html ?? ''),
      }).then(async () => {
        ctx.liveUi?.sendH5AppletLibrary(await listCachedH5Applets(ctx.sessionCwd))
      }).catch(() => undefined)
      return JSON.stringify({
        app_id: applet.appId,
        status: applet.status,
        title: applet.title,
        launch_mode: applet.launchMode,
      })
    } catch (e) {
      return toolError(e instanceof Error ? e.message : String(e))
    }
  },

  update_h5_applet: (args, ctx) => {
    if (!ctx.liveUi) return toolError('LiveUI 未启动，无法热更新 H5 applet。')
    const appId = String(args.app_id ?? '').trim()
    const patchType = parsePatchType(args.patch_type)
    if (!appId) return toolError('app_id 不能为空')
    if (!patchType) return toolError('patch_type 须为 replace/css/state')
    try {
      const applet = ctx.liveUi.updateH5Applet(appId, patchType, String(args.content ?? ''))
      return JSON.stringify({
        app_id: applet.appId,
        status: applet.status,
        patch_type: patchType,
      })
    } catch (e) {
      return toolError(e instanceof Error ? e.message : String(e))
    }
  },

  destroy_h5_applet: (args, ctx) => {
    if (!ctx.liveUi) return toolError('LiveUI 未启动，无法销毁 H5 applet。')
    const appId = String(args.app_id ?? '').trim()
    if (!appId) return toolError('app_id 不能为空')
    try {
      const applet = ctx.liveUi.destroyH5Applet(appId)
      return JSON.stringify({
        app_id: applet.appId,
        status: applet.status,
      })
    } catch (e) {
      return toolError(e instanceof Error ? e.message : String(e))
    }
  },

  http_request: (args) => runHttpRequest({
    method: String(args.method ?? 'GET'),
    url: String(args.url ?? ''),
    headers: args.headers && typeof args.headers === 'object'
      ? (args.headers as Record<string, string>)
      : undefined,
    body: args.body != null ? String(args.body) : undefined,
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
  }),

  bash: (args, ctx) => {
    let cwd: string
    try {
      cwd = typeof args.cwd === 'string' && args.cwd.trim()
        ? resolveWorkspacePath(ctx.sessionCwd, args.cwd)
        : ctx.sessionCwd
    } catch (e) {
      return toolError(e instanceof Error ? e.message : String(e))
    }
    return runBash(String(args.command ?? ''), cwd, args.timeoutMs as number)
  },

  update_memory: async (args, ctx) => {
    const body = String(args.body ?? '')
    if (!body.trim()) return toolError('body 不能为空')
    await appendMemoryEntry(ctx.sessionCwd, {
      title: args.title != null ? String(args.title) : undefined,
      body,
    })
    return JSON.stringify({ ok: true, message: '已写入长期记忆文件（建议改用 memory 工具）' })
  },

  memory: async (args, ctx) => {
    const action = String(args.action ?? '')
    if (!['add', 'replace', 'remove', 'list'].includes(action)) {
      return toolError('action 须为 add/replace/remove/list')
    }
    const act: MemoryAction = action === 'list'
      ? { action: 'list' }
      : action === 'remove'
        ? { action: 'remove', id: String(args.id ?? '') }
        : action === 'replace'
          ? {
              action: 'replace',
              id: String(args.id ?? ''),
              title: args.title != null ? String(args.title) : undefined,
              body: args.body != null ? String(args.body) : undefined,
              tag: args.tag as MemoryTag | undefined,
            }
          : {
              action: 'add',
              title: String(args.title ?? ''),
              body: String(args.body ?? ''),
              tag: args.tag as MemoryTag | undefined,
            }
    return JSON.stringify(await (ctx.memoryCoordinator?.executeMemoryAction(act) ?? executeMemoryAction(ctx.sessionCwd, act)))
  },

  user_profile: async (args, ctx) => {
    const action = String(args.action ?? '')
    if (!['add', 'replace', 'remove', 'list'].includes(action)) {
      return toolError('action 须为 add/replace/remove/list')
    }
    const act: ProfileAction = action === 'list'
      ? { action: 'list' }
      : action === 'remove'
        ? { action: 'remove', id: String(args.id ?? '') }
        : action === 'replace'
          ? {
              action: 'replace',
              id: String(args.id ?? ''),
              title: args.title != null ? String(args.title) : undefined,
              body: args.body != null ? String(args.body) : undefined,
              tag: args.tag as ProfileTag | undefined,
            }
          : {
              action: 'add',
              title: String(args.title ?? ''),
              body: String(args.body ?? ''),
              tag: args.tag as ProfileTag | undefined,
            }
    return JSON.stringify(await (ctx.memoryCoordinator?.executeProfileAction(act) ?? executeProfileAction(ctx.sessionCwd, act)))
  },

  search_sessions: async (args, ctx) => {
    const query = String(args.query ?? '').trim()
    if (!query) return toolError('query 不能为空')
    const limit = typeof args.limit === 'number' ? args.limit : 10
    const results: SearchResult[] = await searchSessions(ctx.sessionCwd, query, limit)
    return JSON.stringify({ ok: true, count: results.length, results })
  },

  knowledge_graph: async (args, ctx) => {
    const action = String(args.action ?? '')
    if (!['add', 'invalidate', 'query', 'timeline', 'stats'].includes(action)) {
      return toolError('action 须为 add/invalidate/query/timeline/stats')
    }
    const act: KgAction = action === 'stats'
      ? { action: 'stats' }
      : action === 'add'
        ? {
            action: 'add',
            subject: String(args.subject ?? ''),
            predicate: String(args.predicate ?? ''),
            object: String(args.object ?? ''),
            valid_from: args.valid_from != null ? String(args.valid_from) : undefined,
            source: args.source != null ? String(args.source) : undefined,
          }
        : action === 'invalidate'
          ? {
              action: 'invalidate',
              subject: String(args.subject ?? ''),
              predicate: String(args.predicate ?? ''),
              object: String(args.object ?? ''),
              ended: args.ended != null ? String(args.ended) : undefined,
            }
          : action === 'query'
            ? {
                action: 'query',
                entity: String(args.entity ?? ''),
                as_of: args.as_of != null ? String(args.as_of) : undefined,
              }
            : {
                action: 'timeline',
                entity: String(args.entity ?? ''),
              }
    return JSON.stringify(await (ctx.memoryCoordinator?.executeKgAction?.(act) ?? executeKgAction(ctx.sessionCwd, act)))
  },

  schedule: async (args, ctx) => {
    const action = String(args.action ?? '')
    if (!['create', 'list', 'remove', 'clear'].includes(action)) {
      return toolError('action 须为 create/list/remove/clear')
    }
    if (action === 'list') {
      const store = await loadScheduleStore(ctx.sessionCwd)
      return JSON.stringify({
        ok: true,
        count: store.tasks.length,
        tasks: store.tasks,
        display: store.tasks.length ? store.tasks.map((task) => formatScheduleTask(task)).join('\n') : '暂无计划任务',
      })
    }
    if (action === 'remove') {
      const id = String(args.id ?? '').trim()
      if (!id) return toolError('id 不能为空')
      const removed = await removeScheduleTask(ctx.sessionCwd, id)
      return JSON.stringify(removed
        ? { ok: true, removed, message: `已删除计划任务：${removed.prompt}` }
        : { ok: false, error: `没有找到计划任务: ${id}` })
    }
    if (action === 'clear') {
      const result = await clearCompletedScheduleTasks(ctx.sessionCwd)
      return JSON.stringify({
        ok: true,
        removed: result.removed,
        removedCount: result.removed.length,
        remaining: result.remaining,
        message: result.removed.length
          ? `已清理 ${result.removed.length} 个未来不再执行的计划任务`
          : '没有需要清理的计划任务',
      })
    }

    const kindRaw = String(args.kind ?? '')
    const prompt = String(args.prompt ?? '').trim()
    if (!['once', 'daily', 'interval'].includes(kindRaw)) return toolError('kind 须为 once/daily/interval')
    const kind = kindRaw as ScheduleKind
    if (!prompt) return toolError('prompt 不能为空')
    if (kind === 'once') {
      const nextRunAt = new Date(String(args.next_run_at ?? ''))
      if (!Number.isFinite(nextRunAt.getTime())) return toolError('once 任务需要合法 next_run_at ISO 时间')
      const task = await addScheduleTask(ctx.sessionCwd, { kind, prompt, nextRunAt })
      return JSON.stringify({ ok: true, task, display: formatScheduleTask(task) })
    }
    if (kind === 'daily') {
      const timeOfDay = String(args.time_of_day ?? '').trim()
      if (!/^\d{1,2}:\d{2}$/.test(timeOfDay)) return toolError('daily 任务需要 time_of_day，格式 HH:mm')
      const task = await addScheduleTask(ctx.sessionCwd, {
        kind,
        prompt,
        timeOfDay,
        nextRunAt: nextDailyRun(timeOfDay, new Date()),
      })
      return JSON.stringify({ ok: true, task, display: formatScheduleTask(task) })
    }
    const intervalMs = typeof args.interval_ms === 'number' ? Math.floor(args.interval_ms) : 0
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) return toolError('interval 任务需要 interval_ms >= 1000')
    const explicitNext = args.next_run_at != null ? new Date(String(args.next_run_at)) : null
    const nextRunAt = explicitNext && Number.isFinite(explicitNext.getTime()) ? explicitNext : new Date(Date.now() + intervalMs)
    const task = await addScheduleTask(ctx.sessionCwd, { kind, prompt, intervalMs, nextRunAt })
    return JSON.stringify({ ok: true, task, display: formatScheduleTask(task) })
  },

  manage_skill: (args, ctx) => {
    const action = String(args.action ?? '')
    const skillName = String(args.name ?? '')
    if (!['create', 'patch', 'delete'].includes(action)) return toolError('action 须为 create/patch/delete')
    if (!skillName.trim()) return toolError('name 不能为空')
    const act: SkillAction = action === 'create'
      ? { action: 'create', name: skillName, content: String(args.content ?? '') }
      : action === 'patch'
        ? {
            action: 'patch',
            name: skillName,
            old_string: String(args.old_string ?? ''),
            new_string: String(args.new_string ?? ''),
          }
        : { action: 'delete', name: skillName }
    return executeSkillAction(ctx.sessionCwd, act).then((result) => JSON.stringify(result))
  },

  snap_photo: async (args, ctx) => {
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) return toolError('prompt 不能为空')
    const job = await enqueueSnapPhotoJob(ctx.sessionCwd, ctx.config, prompt, ctx.snapVision)
    return JSON.stringify({
      ok: true,
      jobId: job.id,
      jobPath: job.jobPath,
      message: '图片生成任务已在后台开始；完成或失败后会写入你的邮箱。',
    })
  },

  avatargen_real2d: async (args, ctx) => {
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) return toolError('prompt 不能为空')
    const job = await enqueueAvatarGenJob(ctx.sessionCwd, ctx.config, prompt, ctx.avatarGenImages ?? [])
    return JSON.stringify({
      ok: true,
      jobId: job.id,
      jobPath: job.jobPath,
      message: 'Real2D 表情集生成任务已在后台开始；完成或失败后会写入你的邮箱。',
    })
  },

  seedance_video: async (args, ctx) => {
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) return toolError('prompt 不能为空')
    const job = await enqueueSeedanceVideoJob(ctx.sessionCwd, ctx.config, prompt, ctx.seedanceImages ?? [])
    return JSON.stringify({
      ok: true,
      jobId: job.id,
      jobPath: job.jobPath,
      message: 'Seedance 视频生成任务已在后台开始；完成或失败后会写入你的邮箱。',
    })
  },

  read_file: (args, ctx) => toolReadFile(ctx.sessionCwd, args),
  list_directory: (args, ctx) => toolListDirectory(ctx.sessionCwd, args),
  glob_files: (args, ctx) => toolGlobFiles(ctx.sessionCwd, args),
  grep_files: (args, ctx) => toolGrepFiles(ctx.sessionCwd, args),
  write_file: (args, ctx) => toolWriteFile(ctx.sessionCwd, args, { editHistory: ctx.editHistory }),
  str_replace: (args, ctx) => toolStrReplace(ctx.sessionCwd, args, { editHistory: ctx.editHistory }),

  send_image: (args, ctx) => sendAssistantMediaTool(args, ctx, 'image'),
  send_video: (args, ctx) => sendAssistantMediaTool(args, ctx, 'video'),
  send_file: (args, ctx) => sendAssistantMediaTool(args, ctx, 'file'),
}

async function sendAssistantMediaTool(
  args: ToolArgs,
  ctx: ToolRunContext,
  kind: 'image' | 'video' | 'file',
): Promise<string> {
  const inputPath = String(args.path ?? '').trim()
  if (!inputPath) return toolError('path 不能为空')
  if (!ctx.liveUi) return toolError('未连接 LiveUI 客户端，无法投递媒体')
  const caption = typeof args.caption === 'string' && args.caption.trim() ? args.caption.trim() : undefined
  const { isAbsolute, resolve } = await import('node:path')
  const { stat } = await import('node:fs/promises')
  const resolved = isAbsolute(inputPath) ? inputPath : resolve(ctx.sessionCwd, inputPath)
  try {
    const info = await stat(resolved)
    if (!info.isFile()) return toolError(`不是文件: ${resolved}`)
  } catch (e) {
    return toolError(`无法访问文件 ${resolved}: ${(e as Error).message}`)
  }
  const result = await ctx.liveUi.sendAssistantMedia({
    filePath: resolved,
    kind,
    caption,
  })
  if (!result.ok) {
    return toolError(result.error ?? `${kind} 发送失败`)
  }
  return JSON.stringify({ ok: true, kind, path: resolved, requestId: result.requestId })
}
