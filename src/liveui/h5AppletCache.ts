import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { InfinitiConfig } from '../config/types.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import { localH5AppletsDir } from '../paths.js'
import type { H5AppletLaunchMode, H5AppletPermissions } from './appletRuntime.js'

export type CachedH5Applet = {
  version: 1
  id: string
  key: string
  title: string
  description: string
  launchMode: H5AppletLaunchMode
  permissions: Partial<H5AppletPermissions>
  html: string
  createdAt: string
  updatedAt: string
}

export type H5AppletLibraryItem = {
  id: string
  key: string
  title: string
  description: string
  launchMode: H5AppletLaunchMode
  updatedAt: string
}

export function h5AppletCacheKey(title: string, description = ''): string {
  const normalized = `${title}\n${description}`
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
  const base = normalized || title.trim().toLowerCase() || 'applet'
  return createHash('sha256').update(base).digest('hex').slice(0, 16)
}

export async function listCachedH5Applets(cwd: string): Promise<H5AppletLibraryItem[]> {
  const dir = localH5AppletsDir(cwd)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const items: H5AppletLibraryItem[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const app = validateCachedH5Applet(JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown)
      items.push(toLibraryItem(app))
    } catch {
      /* ignore bad cache files */
    }
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readCachedH5Applet(cwd: string, keyOrId: string): Promise<CachedH5Applet | null> {
  const dir = localH5AppletsDir(cwd)
  const direct = await readCacheFile(join(dir, `${safeFileName(keyOrId)}.json`))
  if (direct) return direct
  const all = await listCacheEntries(cwd)
  return all.find((a) => a.id === keyOrId || a.key === keyOrId) ?? null
}

export async function findCachedH5Applet(
  cwd: string,
  title: string,
  description = '',
): Promise<CachedH5Applet | null> {
  const key = h5AppletCacheKey(title, description)
  const exact = await readCachedH5Applet(cwd, key)
  if (exact) return exact
  const titleNorm = normalizeTitle(title)
  const all = await listCacheEntries(cwd)
  return all.find((a) => normalizeTitle(a.title) === titleNorm) ?? null
}

export async function deleteCachedH5Applet(cwd: string, input: {
  keyOrId?: string
  title?: string
}): Promise<CachedH5Applet | null> {
  const keyOrId = input.keyOrId?.trim()
  const title = input.title?.trim()
  const app = keyOrId
    ? await readCachedH5Applet(cwd, keyOrId)
    : title
      ? await findCachedH5Applet(cwd, title)
      : null
  if (!app) return null
  await rm(join(localH5AppletsDir(cwd), `${safeFileName(app.key)}.json`), { force: true })
  return app
}

export async function writeCachedH5Applet(
  cwd: string,
  applet: Omit<CachedH5Applet, 'version' | 'id' | 'key' | 'createdAt' | 'updatedAt'> & {
    key?: string
    id?: string
  },
): Promise<CachedH5Applet> {
  const now = new Date().toISOString()
  const key = applet.key ?? h5AppletCacheKey(applet.title, applet.description)
  const cached: CachedH5Applet = {
    version: 1,
    id: applet.id ?? `h5_${key}`,
    key,
    title: applet.title,
    description: applet.description,
    launchMode: applet.launchMode,
    permissions: applet.permissions,
    html: applet.html,
    createdAt: now,
    updatedAt: now,
  }
  const dir = localH5AppletsDir(cwd)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${safeFileName(key)}.json`), JSON.stringify(cached, null, 2) + '\n', 'utf8')
  return cached
}

export async function generateH5AppletHtml(args: {
  config: InfinitiConfig
  title: string
  description: string
}): Promise<string> {
  const out = await oneShotTextCompletion({
    config: args.config,
    maxOutTokens: 6000,
    system: [
      '你是 Linkyun Live H5 Applet 的专用前端子 agent。',
      '只输出一个完整、可运行、单文件 HTML 文档，不要 Markdown，不要解释。',
      '约束：只用 inline CSS 和 inline JS；不要外链脚本；不要 fetch/WebSocket；不要 eval/Function；不要 localStorage；可以使用 sessionStorage。',
      '页面必须优先适配 1280x768 的 applet 舞台，并能缩放适配更小 iframe；主要内容必须完整可见，不要依赖浏览器滚动才能看到核心控件。',
      '如果有用户交互，用 window.__LINKYUN_APPLET__?.emit(event, payload) 或 window.parent.postMessage({ type:"APP_EVENT", event, payload }, "*") 上报。',
      '视觉风格要像直播互动快应用，控件清晰，触控友好。',
    ].join('\n'),
    user: [
      `快应用标题：${args.title}`,
      args.description.trim() ? `需求描述：${args.description}` : '',
      '请生成完整 HTML。',
    ].filter(Boolean).join('\n'),
  })
  return extractHtml(out)
}

export function toLibraryItem(app: CachedH5Applet): H5AppletLibraryItem {
  return {
    id: app.id,
    key: app.key,
    title: app.title,
    description: app.description,
    launchMode: app.launchMode,
    updatedAt: app.updatedAt,
  }
}

async function listCacheEntries(cwd: string): Promise<CachedH5Applet[]> {
  const items = await listCachedH5Applets(cwd)
  const entries: CachedH5Applet[] = []
  for (const item of items) {
    const app = await readCachedH5Applet(cwd, item.key)
    if (app) entries.push(app)
  }
  return entries
}

async function readCacheFile(path: string): Promise<CachedH5Applet | null> {
  try {
    return validateCachedH5Applet(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch {
    return null
  }
}

function validateCachedH5Applet(raw: unknown): CachedH5Applet {
  if (!raw || typeof raw !== 'object') throw new Error('invalid cached applet')
  const r = raw as Partial<CachedH5Applet>
  if (r.version !== 1) throw new Error('unsupported cached applet version')
  if (!r.id || !r.key || !r.title || typeof r.html !== 'string') throw new Error('invalid cached applet')
  const launchMode = r.launchMode === 'floating' || r.launchMode === 'fullscreen' || r.launchMode === 'overlay'
    ? r.launchMode
    : 'live_panel'
  return {
    version: 1,
    id: r.id,
    key: r.key,
    title: r.title,
    description: r.description ?? '',
    launchMode,
    permissions: r.permissions ?? { network: false, storage: 'session' },
    html: r.html,
    createdAt: r.createdAt ?? new Date(0).toISOString(),
    updatedAt: r.updatedAt ?? r.createdAt ?? new Date(0).toISOString(),
  }
}

function extractHtml(text: string): string {
  const fenced = /```html\s*([\s\S]*?)```/i.exec(text) ?? /```\s*([\s\S]*?)```/i.exec(text)
  const html = (fenced?.[1] ?? text).trim()
  const docStart = html.search(/<!doctype html|<html[\s>]/i)
  if (docStart >= 0) return html.slice(docStart).trim()
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'applet'
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().normalize('NFKC').replace(/\s+/g, '').trim()
}
