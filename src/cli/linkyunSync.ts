import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { existsSync } from 'node:fs'
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { ensureLocalAgentDir } from '../config/io.js'
import { localAgentDir, localLinkyunRefDir, localSessionPath } from '../paths.js'
import { exportAgentArchive, importAgentArchive } from './agentArchive.js'

const DEFAULT_API_BASE = 'https://api.linkyun.co'
const ENV_LOCAL = '.env.local'
const SYNC_HISTORY_PATH = 'sync-history.jsonl'
const DEVICE_PATH = 'device.json'
const MAX_SYNC_BACKUPS = 5

const CRITICAL_BACKUP_PATHS = [
  'SOUL.md',
  'INFINITI.md',
  '.infiniti-agent/session.json',
  '.infiniti-agent/memory.json',
  '.infiniti-agent/subconscious.json',
  '.infiniti-agent/schedules.json',
  '.infiniti-agent/sessions.db',
  '.infiniti-agent/knowledge.db',
] as const

type ApiEnvelope = {
  success?: boolean
  data?: unknown
  error?: { message?: string; code?: string }
}

function unwrapData<T>(json: unknown): T {
  if (json && typeof json === 'object' && 'data' in json && (json as ApiEnvelope).data !== undefined) {
    return (json as ApiEnvelope).data as T
  }
  return json as T
}

function apiErrorMessage(json: unknown, status: number): string {
  if (json && typeof json === 'object' && 'error' in json) {
    const m = (json as ApiEnvelope).error?.message
    if (m) return m
  }
  return `HTTP ${status}`
}

function normalizeApiBase(raw: string): string {
  let s = raw.trim()
  if (!s) return DEFAULT_API_BASE
  s = s.replace(/\/+$/, '')
  if (s.endsWith('/api/v1')) {
    s = s.slice(0, -'/api/v1'.length)
  }
  return s
}

function apiV1(base: string, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return `${normalizeApiBase(base)}/api/v1${p}`
}

/** 在 URL 后追加 t=时间戳，避免 CDN / 代理返回旧缓存。 */
function withNoCacheTimestamp(url: string): string {
  const t = Date.now()
  return url.includes('?') ? `${url}&t=${t}` : `${url}?t=${t}`
}

async function readPasswordHidden(prompt: string): Promise<string> {
  const stdin = input
  const stdout = output
  if (!stdin.isTTY) {
    const rl = readline.createInterface({ input, output })
    try {
      stdout.write('（当前非 TTY，密码可能回显）\n')
      return (await rl.question(prompt)).trimEnd()
    } finally {
      rl.close()
    }
  }

  stdout.write(prompt)
  const wasRaw = stdin.isRaw
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')

  let line = ''
  return await new Promise((resolve, reject) => {
    const onData = (char: string) => {
      if (char === '\u0003') {
        stdin.removeListener('data', onData)
        stdin.setRawMode(!!wasRaw)
        stdin.pause()
        reject(new Error('已取消'))
        return
      }
      if (char === '\r' || char === '\n') {
        stdin.removeListener('data', onData)
        stdin.setRawMode(!!wasRaw)
        stdin.pause()
        stdout.write('\n')
        resolve(line)
        return
      }
      if (char === '\u007f' || char === '\b') {
        line = line.slice(0, -1)
        return
      }
      line += char
    }
    stdin.on('data', onData)
  })
}

type LoginData = {
  api_key?: string
  workspace?: { code?: string; id?: number; name?: string }
}

type AgentSummary = {
  id: number
  name?: string
  code?: string
  status?: string
  system_prompt?: string
}

type AgentDetail = AgentSummary & {
  config?: {
    system_prompt?: string
    metadata?: Record<string, unknown>
  }
}

type ListAgentsData = {
  agents?: AgentSummary[]
  total?: number
}

type AgentArchiveSummary = {
  id: number
  uuid?: string
  original_filename?: string
  file_size?: number
  checksum_sha256?: string
  created_at?: string
  download_url?: string
}

type ListArchivesData = {
  agent_code?: string
  archives?: AgentArchiveSummary[]
}

type UploadArchiveData = {
  agent_code?: string
  archive?: AgentArchiveSummary
}

type LinkyunLocalEnv = {
  LINKYUN_API_BASE?: string
  LINKYUN_API_KEY?: string
  LINKYUN_WORKSPACE_CODE?: string
  LINKYUN_AGENT_CODE?: string
}

type SyncHistoryEntry = {
  ts: string
  deviceId: string
  agentCode: string
  mode: 'manual' | 'startup-pull' | 'shutdown-push'
  decision: string
  status: 'ok' | 'error'
  localSessionMtime?: string
  remoteVersion?: string
  resultVersion?: string
  error?: string
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  let json: unknown
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { ok: res.ok, status: res.status, json }
}

async function postMultipart(
  url: string,
  headers: Record<string, string>,
  filePath: string,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const data = await readFile(filePath)
  const boundary = `----infiniti-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${basename(filePath).replace(/"/g, '%22')}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  )
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = Buffer.concat([header, data, footer])
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...headers,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    })
  } catch (e) {
    const cause = (e as Error & { cause?: { message?: string; code?: string } }).cause
    const detail = cause?.message ?? cause?.code ?? (e as Error).message
    throw new Error(`上传 .agent 归档失败: ${detail}`)
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { ok: res.ok, status: res.status, json }
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
  })
  let json: unknown
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { ok: res.ok, status: res.status, json }
}

async function getBinary(url: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; buf: Buffer }> {
  const res = await fetch(url, { method: 'GET', headers })
  const ab = await res.arrayBuffer()
  return { ok: res.ok, status: res.status, buf: Buffer.from(ab) }
}

function parseEnvLocal(raw: string): LinkyunLocalEnv {
  const out: LinkyunLocalEnv = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
    if (!match) continue
    const key = match[1] as keyof LinkyunLocalEnv
    let value = match[2] ?? ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key.startsWith('LINKYUN_')) out[key] = value
  }
  return out
}

function envValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value
  return JSON.stringify(value)
}

async function loadLocalEnv(cwd: string): Promise<LinkyunLocalEnv> {
  try {
    return parseEnvLocal(await readFile(join(cwd, ENV_LOCAL), 'utf8'))
  } catch {
    return {}
  }
}

async function saveLocalEnv(cwd: string, env: LinkyunLocalEnv): Promise<void> {
  const existing = existsSync(join(cwd, ENV_LOCAL))
    ? await readFile(join(cwd, ENV_LOCAL), 'utf8').catch(() => '')
    : ''
  const preserved = existing
    .split(/\r?\n/)
    .filter((line) => {
      const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim())?.[1]
      return key ? !key.startsWith('LINKYUN_') : line.trim() !== ''
    })
  const managed = [
    `LINKYUN_API_BASE=${envValue(env.LINKYUN_API_BASE ?? DEFAULT_API_BASE)}`,
    env.LINKYUN_API_KEY ? `LINKYUN_API_KEY=${envValue(env.LINKYUN_API_KEY)}` : '',
    env.LINKYUN_WORKSPACE_CODE ? `LINKYUN_WORKSPACE_CODE=${envValue(env.LINKYUN_WORKSPACE_CODE)}` : '',
    env.LINKYUN_AGENT_CODE ? `LINKYUN_AGENT_CODE=${envValue(env.LINKYUN_AGENT_CODE)}` : '',
  ].filter(Boolean)
  await writeFile(join(cwd, ENV_LOCAL), [...preserved, ...managed, ''].join('\n'), { encoding: 'utf8', mode: 0o600 })
}

function pickPrompt(agent: AgentDetail): string {
  const fromRoot = agent.system_prompt?.trim() ?? ''
  if (fromRoot) return fromRoot
  const fromCfg = agent.config?.system_prompt?.trim() ?? ''
  return fromCfg
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!meta) return undefined
  const v = meta[key]
  if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

/** ref 目录名：优先 API 的 code；异常或缺失时退回 id- 前缀避免路径穿越 */
function refDirNameFromAgent(code: string | undefined, agentId: number): string {
  const raw = (code ?? '').trim()
  if (raw && !/[./\\]/.test(raw)) return raw
  return `id-${agentId}`
}

export type LinkyunSyncOptions = {
  apiBase?: string
  agentCode?: string
  /** 覆盖登录后默认空间，对应 X-Workspace-Code */
  workspaceCode?: string
  forceLogin?: boolean
  pull?: boolean
  push?: boolean
  withVersion?: boolean
}

function buildHeaders(apiKey: string, workspaceCode?: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-API-Key': apiKey }
  if (workspaceCode) headers['X-Workspace-Code'] = workspaceCode
  return headers
}

async function promptLogin(
  apiBase: string,
  rl: readline.Interface,
): Promise<{ apiKey: string; workspaceCode?: string; workspaceName?: string } | null> {
  const username = (await rl.question('用户名或邮箱: ')).trim()
  if (!username) {
    console.error('用户名不能为空')
    process.exitCode = 2
    return null
  }

  await rl.close()

  const password = await readPasswordHidden('密码（不回显）: ')
  if (!password) {
    console.error('密码不能为空')
    process.exitCode = 2
    return null
  }

  const loginUrl = apiV1(apiBase, '/auth/login')
  const loginRes = await postJson(loginUrl, { username, password })
  if (!loginRes.ok) {
    console.error(`登录失败: ${apiErrorMessage(loginRes.json, loginRes.status)}`)
    process.exitCode = 2
    return null
  }

  const loginData = unwrapData<LoginData>(loginRes.json)
  const apiKey = loginData.api_key?.trim()
  if (!apiKey) {
    console.error('登录响应中缺少 api_key')
    process.exitCode = 2
    return null
  }

  const workspaceCode = typeof loginData.workspace?.code === 'string' ? loginData.workspace.code.trim() : undefined
  return {
    apiKey,
    workspaceCode,
    workspaceName: loginData.workspace?.name,
  }
}

async function listAgents(apiBase: string, headers: Record<string, string>): Promise<AgentSummary[] | null> {
  const listUrl = new URL(apiV1(apiBase, '/agents'))
  listUrl.searchParams.set('limit', '500')
  const listRes = await getJson(listUrl.toString(), headers)
  if (!listRes.ok) {
    console.error(`列出 Agent 失败: ${apiErrorMessage(listRes.json, listRes.status)}`)
    process.exitCode = 2
    return null
  }

  const listData = unwrapData<ListAgentsData>(listRes.json)
  const agents = listData.agents ?? []
  if (!agents.length) {
    console.error('当前账号下没有可用的 AI Agent。')
    process.exitCode = 2
    return null
  }
  return agents
}

async function chooseAgent(agents: AgentSummary[], preferredCode?: string): Promise<AgentSummary | null> {
  const preferred = preferredCode?.trim()
  if (preferred) {
    const selected = agents.find((a) => a.code === preferred)
    if (selected) {
      console.error(`Agent: ${selected.name ?? '(未命名)'} · ${selected.code ?? selected.id}`)
      return selected
    }
    console.error(`（提示）未在当前账号列表中找到 LINKYUN_AGENT_CODE=${preferred}，请重新选择。`)
  }

  console.error('\n可选 Agent（输入序号）:\n')
  agents.forEach((a, i) => {
    const name = a.name ?? '(未命名)'
    const code = a.code ? ` · ${a.code}` : ''
    const st = a.status ? ` · ${a.status}` : ''
    console.error(`  ${i + 1}) [${a.id}] ${name}${code}${st}`)
  })

  const rl = readline.createInterface({ input, output })
  try {
    const pickRaw = (await rl.question('\n请选择序号: ')).trim()
    const pick = Number(pickRaw)
    if (!Number.isFinite(pick) || pick < 1 || pick > agents.length) {
      console.error('无效序号')
      process.exitCode = 2
      return null
    }
    return agents[pick - 1]!
  } finally {
    rl.close()
  }
}

async function syncAgentMetadata(
  cwd: string,
  apiBase: string,
  headers: Record<string, string>,
  agent: AgentDetail,
): Promise<void> {
  const promptText = pickPrompt(agent)
  if (!promptText) {
    console.error('该 Agent 没有可用的 system_prompt，跳过 SOUL.md 同步。')
  } else {
    const soulPath = join(cwd, 'SOUL.md')
    await writeFile(soulPath, promptText.endsWith('\n') ? promptText : `${promptText}\n`, 'utf8')
    console.error(`\n✓ 已写入 SOUL.md: ${soulPath}`)
  }

  const refDir = localLinkyunRefDir(cwd, refDirNameFromAgent(agent.code, agent.id))
  await mkdir(refDir, { recursive: true })

  const meta = agent.config?.metadata
  const avatarFile = metaString(meta, 'avatar')
  const sheetFile = metaString(meta, 'character_design_sheet')
  const specText = metaString(meta, 'character_design_spec')

  const downloads: string[] = []

  if (avatarFile) {
    const avatarUrl = withNoCacheTimestamp(apiV1(apiBase, `/avatars/${encodeURIComponent(avatarFile)}`))
    const img = await getBinary(avatarUrl, headers)
    if (img.ok && img.buf.length > 0) {
      const ext = avatarFile.includes('.') ? avatarFile.slice(avatarFile.lastIndexOf('.')) : '.jpg'
      const dest = join(refDir, `avatar${ext}`)
      await writeFile(dest, img.buf)
      downloads.push(dest)
    } else {
      console.error(`（警告）头像下载失败: HTTP ${img.status} — ${avatarUrl}`)
    }
  }

  if (sheetFile) {
    const sheetUrl = withNoCacheTimestamp(apiV1(apiBase, `/character-sheets/${encodeURIComponent(sheetFile)}`))
    const img = await getBinary(sheetUrl, headers)
    if (img.ok && img.buf.length > 0) {
      const safeName = sheetFile.replace(/[/\\]/g, '_')
      const dest = join(refDir, safeName)
      await writeFile(dest, img.buf)
      downloads.push(dest)
    } else {
      console.error(`（警告）角色设计稿图下载失败: HTTP ${img.status}`)
    }
  }

  if (specText) {
    const dest = join(refDir, 'character_design_spec.md')
    await writeFile(dest, specText.endsWith('\n') ? specText : `${specText}\n`, 'utf8')
    downloads.push(dest)
  }

  console.error(`✓ 资源目录: ${refDir}`)
  if (downloads.length) {
    console.error('✓ 已保存文件:')
    for (const p of downloads) {
      console.error(`    ${p}`)
    }
  } else {
    console.error('（该 Agent 未配置头像或角色设定稿元数据，仅同步了提示词。）')
  }
}

async function localSessionMtimeMs(cwd: string): Promise<number | null> {
  try {
    return (await stat(localSessionPath(cwd))).mtimeMs
  } catch {
    return null
  }
}

function archiveTimeMs(archive: AgentArchiveSummary | undefined): number | null {
  if (!archive?.created_at) return null
  const t = Date.parse(archive.created_at)
  return Number.isFinite(t) ? t : null
}

function isoFromMs(ms: number | null | undefined): string | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

async function deviceId(cwd: string): Promise<string> {
  const path = join(localAgentDir(cwd), DEVICE_PATH)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { deviceId?: unknown }
    if (typeof parsed.deviceId === 'string' && parsed.deviceId.trim()) return parsed.deviceId.trim()
  } catch {
    // create below
  }
  const id = `${hostname().replace(/[^a-zA-Z0-9_.-]/g, '-')}-${randomUUID().slice(0, 8)}`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ deviceId: id, createdAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  return id
}

async function recordSyncHistory(
  cwd: string,
  entry: Omit<SyncHistoryEntry, 'ts' | 'deviceId'>,
): Promise<void> {
  try {
    const full = {
      ts: new Date().toISOString(),
      deviceId: await deviceId(cwd),
      ...entry,
    }
    const path = join(localAgentDir(cwd), SYNC_HISTORY_PATH)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(full) + '\n', 'utf8')
  } catch {
    // History is diagnostic only; sync should not fail because of it.
  }
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function backupCriticalFiles(cwd: string, reason: string): Promise<string | null> {
  const backupRoot = join(localAgentDir(cwd), 'backups', 'sync')
  const destRoot = join(backupRoot, `${backupStamp()}-${reason}`)
  let copied = 0
  for (const rel of CRITICAL_BACKUP_PATHS) {
    const src = join(cwd, rel)
    if (!existsSync(src)) continue
    const dest = join(destRoot, rel)
    await mkdir(dirname(dest), { recursive: true })
    await cp(src, dest, { recursive: true })
    copied++
  }
  if (!copied) return null
  await pruneSyncBackups(backupRoot)
  return destRoot
}

async function pruneSyncBackups(backupRoot: string): Promise<void> {
  try {
    const names = (await readdir(backupRoot)).sort()
    const extra = names.slice(0, Math.max(0, names.length - MAX_SYNC_BACKUPS))
    for (const name of extra) {
      await rm(join(backupRoot, name), { recursive: true, force: true })
    }
  } catch {
    // best effort
  }
}

async function listAgentArchives(
  apiBase: string,
  headers: Record<string, string>,
  agentCode: string,
): Promise<AgentArchiveSummary[]> {
  const res = await getJson(apiV1(apiBase, `/agents/by-code/${encodeURIComponent(agentCode)}/agent-archives`), headers)
  if (!res.ok) {
    throw new Error(`查询 .agent 归档失败: ${apiErrorMessage(res.json, res.status)}`)
  }
  const data = unwrapData<ListArchivesData>(res.json)
  return data.archives ?? []
}

function archiveLabel(archive: AgentArchiveSummary): string {
  const created = archive.created_at ?? '(unknown time)'
  const file = archive.original_filename ?? 'unknown.agent'
  const size = typeof archive.file_size === 'number' ? ` · ${Math.round(archive.file_size / 1024)}KB` : ''
  const checksum = archive.checksum_sha256 ? ` · ${archive.checksum_sha256.slice(0, 10)}` : ''
  return `[${archive.id}] ${created} · ${file}${size}${checksum}`
}

async function chooseArchiveVersion(archives: AgentArchiveSummary[]): Promise<AgentArchiveSummary | null> {
  if (!archives.length) {
    console.error('服务器上没有可选择的 .agent 归档版本。')
    process.exitCode = 2
    return null
  }

  console.error('\n可选 .agent 版本（最新在前，输入序号）:\n')
  archives.forEach((archive, i) => {
    console.error(`  ${i + 1}) ${archiveLabel(archive)}`)
  })

  const rl = readline.createInterface({ input, output })
  try {
    const pickRaw = (await rl.question('\n请选择版本序号: ')).trim()
    const pick = Number(pickRaw)
    if (!Number.isFinite(pick) || pick < 1 || pick > archives.length) {
      console.error('无效序号')
      process.exitCode = 2
      return null
    }
    return archives[pick - 1]!
  } finally {
    rl.close()
  }
}

async function downloadAgentArchive(
  apiBase: string,
  headers: Record<string, string>,
  agentCode: string,
  archive: AgentArchiveSummary | 'latest',
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'infiniti-agent-sync-'))
  const dest = join(dir, `${agentCode}.agent`)
  const url =
    archive === 'latest'
      ? apiV1(apiBase, `/agents/by-code/${encodeURIComponent(agentCode)}/agent-archives/latest/download`)
      : archive.download_url?.startsWith('http://') || archive.download_url?.startsWith('https://')
        ? archive.download_url
        : archive.download_url
          ? `${normalizeApiBase(apiBase)}${archive.download_url.startsWith('/') ? archive.download_url : `/${archive.download_url}`}`
        : apiV1(apiBase, `/agents/by-code/${encodeURIComponent(agentCode)}/agent-archives/${archive.id}/download`)
  const res = await getBinary(url, headers)
  if (!res.ok || res.buf.length === 0) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`下载 .agent 归档失败: HTTP ${res.status}`)
  }
  await writeFile(dest, res.buf)
  return dest
}

async function uploadAgentArchive(
  cwd: string,
  apiBase: string,
  headers: Record<string, string>,
  agentCode: string,
): Promise<AgentArchiveSummary | null> {
  const dir = await mkdtemp(join(tmpdir(), 'infiniti-agent-sync-'))
  const archivePath = join(dir, `${agentCode}.agent`)
  try {
    const exported = await exportAgentArchive(cwd, archivePath)
    const res = await postMultipart(
      apiV1(apiBase, `/agents/by-code/${encodeURIComponent(agentCode)}/agent-archives`),
      headers,
      exported.archivePath,
    )
    if (!res.ok) {
      throw new Error(`上传 .agent 归档失败: ${apiErrorMessage(res.json, res.status)}`)
    }
    console.error(`✓ 已上传 .agent 归档: ${agentCode}.agent`)
    return unwrapData<UploadArchiveData>(res.json).archive ?? null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function alignLocalSessionMtime(cwd: string, timeMs: number | null): Promise<void> {
  if (timeMs === null) return
  const path = localSessionPath(cwd)
  if (!existsSync(path)) return
  const date = new Date(timeMs)
  await utimes(path, date, date).catch(() => {})
}

async function syncAgentArchive(
  cwd: string,
  apiBase: string,
  headers: Record<string, string>,
  agentCode: string,
  localSessionBeforeSync: number | null,
  opts: Pick<LinkyunSyncOptions, 'pull' | 'push' | 'withVersion'>,
): Promise<void> {
  if (opts.pull && opts.push) {
    throw new Error('不能同时指定 --pull 和 --push')
  }
  if (opts.withVersion && opts.push) {
    throw new Error('不能同时指定 --with-version 和 --push')
  }

  if (opts.push) {
    const uploaded = await uploadAgentArchive(cwd, apiBase, headers, agentCode)
    await alignLocalSessionMtime(cwd, archiveTimeMs(uploaded ?? undefined))
    await recordSyncHistory(cwd, {
      agentCode,
      mode: 'manual',
      decision: 'push-forced',
      status: 'ok',
      localSessionMtime: isoFromMs(localSessionBeforeSync),
      resultVersion: uploaded?.created_at,
    })
    return
  }

  const archives = await listAgentArchives(apiBase, headers, agentCode)
  const latest = archives[0]
  const remoteMs = archiveTimeMs(latest)

  if (opts.withVersion) {
    const selected = await chooseArchiveVersion(archives)
    if (!selected) return
    const selectedMs = archiveTimeMs(selected)
    const downloaded = await downloadAgentArchive(apiBase, headers, agentCode, selected)
    try {
      const backup = await backupCriticalFiles(cwd, 'manual-version-pull')
      await importAgentArchive(cwd, downloaded, { force: true })
      await alignLocalSessionMtime(cwd, selectedMs)
      await recordSyncHistory(cwd, {
        agentCode,
        mode: 'manual',
        decision: 'version-pull',
        status: 'ok',
        localSessionMtime: isoFromMs(localSessionBeforeSync),
        remoteVersion: selected.created_at,
        resultVersion: selected.created_at,
      })
      console.error(
        `✓ 已从服务器下载并导入指定 .agent 版本: ${archiveLabel(selected)}${backup ? `（备份: ${backup}）` : ''}`,
      )
    } finally {
      await rm(dirname(downloaded), { recursive: true, force: true })
    }
    return
  }

  if (opts.pull) {
    if (!latest) throw new Error('服务器上没有可下载的 .agent 归档')
    const downloaded = await downloadAgentArchive(apiBase, headers, agentCode, 'latest')
    try {
      await backupCriticalFiles(cwd, 'manual-pull')
      await importAgentArchive(cwd, downloaded, { force: true })
      await alignLocalSessionMtime(cwd, remoteMs)
      await recordSyncHistory(cwd, {
        agentCode,
        mode: 'manual',
        decision: 'pull-forced',
        status: 'ok',
        localSessionMtime: isoFromMs(localSessionBeforeSync),
        remoteVersion: latest.created_at,
        resultVersion: latest.created_at,
      })
      console.error(`✓ 已从服务器下载并导入最新 .agent 归档: ${latest.original_filename ?? `${agentCode}.agent`}`)
    } finally {
      await rm(dirname(downloaded), { recursive: true, force: true })
    }
    return
  }

  if (latest && remoteMs !== null && (localSessionBeforeSync === null || remoteMs > localSessionBeforeSync)) {
    const downloaded = await downloadAgentArchive(apiBase, headers, agentCode, 'latest')
    try {
      await backupCriticalFiles(cwd, 'manual-remote-newer')
      await importAgentArchive(cwd, downloaded, { force: true })
      await alignLocalSessionMtime(cwd, remoteMs)
      await recordSyncHistory(cwd, {
        agentCode,
        mode: 'manual',
        decision: 'remote-newer-pull',
        status: 'ok',
        localSessionMtime: isoFromMs(localSessionBeforeSync),
        remoteVersion: latest.created_at,
        resultVersion: latest.created_at,
      })
      console.error(`✓ 服务器 .agent 较新，已下载并导入: ${latest.original_filename ?? `${agentCode}.agent`}`)
    } finally {
      await rm(dirname(downloaded), { recursive: true, force: true })
    }
    return
  }

  if (!latest) {
    console.error('服务器上还没有 .agent 归档，准备上传本地版本。')
    const uploaded = await uploadAgentArchive(cwd, apiBase, headers, agentCode)
    await alignLocalSessionMtime(cwd, archiveTimeMs(uploaded ?? undefined))
    await recordSyncHistory(cwd, {
      agentCode,
      mode: 'manual',
      decision: 'no-remote-push',
      status: 'ok',
      localSessionMtime: isoFromMs(localSessionBeforeSync),
      resultVersion: uploaded?.created_at,
    })
  } else if (remoteMs !== null && localSessionBeforeSync !== null && localSessionBeforeSync > remoteMs) {
    console.error('本地 session.json 新于服务器 .agent，准备上传本地版本。')
    const uploaded = await uploadAgentArchive(cwd, apiBase, headers, agentCode)
    await alignLocalSessionMtime(cwd, archiveTimeMs(uploaded ?? undefined))
    await recordSyncHistory(cwd, {
      agentCode,
      mode: 'manual',
      decision: 'local-newer-push',
      status: 'ok',
      localSessionMtime: isoFromMs(localSessionBeforeSync),
      remoteVersion: latest.created_at,
      resultVersion: uploaded?.created_at,
    })
  } else {
    console.error('✓ 本地与服务器 .agent 已同步，无需上传或下载。')
    await recordSyncHistory(cwd, {
      agentCode,
      mode: 'manual',
      decision: 'up-to-date',
      status: 'ok',
      localSessionMtime: isoFromMs(localSessionBeforeSync),
      remoteVersion: latest.created_at,
    })
  }
}

export async function runLinkyunStartupSync(cwd: string): Promise<boolean> {
  const env = await loadLocalEnv(cwd)
  const apiKey = env.LINKYUN_API_KEY?.trim()
  const agentCode = env.LINKYUN_AGENT_CODE?.trim()
  if (!apiKey || !agentCode) return false
  const apiBase = normalizeApiBase(env.LINKYUN_API_BASE?.trim() || DEFAULT_API_BASE)
  const headers = buildHeaders(apiKey, env.LINKYUN_WORKSPACE_CODE?.trim())
  const localSessionBeforeSync = await localSessionMtimeMs(cwd)
  console.error(`[sync] 启动同步 LinkYun Agent: ${agentCode}`)
  const archives = await listAgentArchives(apiBase, headers, agentCode)
  const latest = archives[0]
  const remoteMs = archiveTimeMs(latest)
  if (!latest || remoteMs === null) {
    console.error('[sync] 服务器暂无 .agent 归档，启动时不自动上传。')
    await recordSyncHistory(cwd, {
      agentCode,
      mode: 'startup-pull',
      decision: 'no-remote-skip-push',
      status: 'ok',
      localSessionMtime: isoFromMs(localSessionBeforeSync),
    })
    return true
  }
  if (localSessionBeforeSync !== null && localSessionBeforeSync >= remoteMs) {
    console.error('[sync] 本地不旧于服务器，启动时不自动上传。')
    await recordSyncHistory(cwd, {
      agentCode,
      mode: 'startup-pull',
      decision: 'local-newer-skip-push',
      status: 'ok',
      localSessionMtime: isoFromMs(localSessionBeforeSync),
      remoteVersion: latest.created_at,
    })
    return true
  }
  const downloaded = await downloadAgentArchive(apiBase, headers, agentCode, 'latest')
  try {
    const backup = await backupCriticalFiles(cwd, 'startup-pull')
    await importAgentArchive(cwd, downloaded, { force: true })
    await alignLocalSessionMtime(cwd, remoteMs)
    console.error(`✓ 服务器 .agent 较新，已启动前导入${backup ? `（备份: ${backup}）` : ''}`)
    await recordSyncHistory(cwd, {
      agentCode,
      mode: 'startup-pull',
      decision: 'remote-newer-pull',
      status: 'ok',
      localSessionMtime: isoFromMs(localSessionBeforeSync),
      remoteVersion: latest.created_at,
      resultVersion: latest.created_at,
    })
  } finally {
    await rm(dirname(downloaded), { recursive: true, force: true })
  }
  return true
}

export async function runLinkyunShutdownPush(cwd: string): Promise<boolean> {
  const env = await loadLocalEnv(cwd)
  const apiKey = env.LINKYUN_API_KEY?.trim()
  const agentCode = env.LINKYUN_AGENT_CODE?.trim()
  if (!apiKey || !agentCode) return false
  const apiBase = normalizeApiBase(env.LINKYUN_API_BASE?.trim() || DEFAULT_API_BASE)
  const headers = buildHeaders(apiKey, env.LINKYUN_WORKSPACE_CODE?.trim())
  const localSessionBeforeSync = await localSessionMtimeMs(cwd)
  console.error(`[sync] 结束同步 LinkYun Agent: ${agentCode}`)
  try {
    const uploaded = await uploadAgentArchive(cwd, apiBase, headers, agentCode)
    await alignLocalSessionMtime(cwd, archiveTimeMs(uploaded ?? undefined))
    await recordSyncHistory(cwd, {
      agentCode,
      mode: 'shutdown-push',
      decision: 'push',
      status: 'ok',
      localSessionMtime: isoFromMs(localSessionBeforeSync),
      resultVersion: uploaded?.created_at,
    })
    return true
  } catch (e) {
    await recordSyncHistory(cwd, {
      agentCode,
      mode: 'shutdown-push',
      decision: 'push',
      status: 'error',
      localSessionMtime: isoFromMs(localSessionBeforeSync),
      error: (e as Error).message,
    })
    throw e
  }
}

export async function runLinkyunSync(cwd: string, opts: LinkyunSyncOptions = {}): Promise<void> {
  const rl = readline.createInterface({ input, output })
  const env = await loadLocalEnv(cwd)
  const apiBaseInput = opts.apiBase?.trim() || env.LINKYUN_API_BASE?.trim()
  let apiBase = apiBaseInput ? normalizeApiBase(apiBaseInput) : DEFAULT_API_BASE
  const localSessionBeforeSync = await localSessionMtimeMs(cwd)

  try {
    console.error('\n=== infiniti-agent sync — LinkYun Agent 双向同步 ===\n')
    if (!apiBaseInput) {
      const b = (await rl.question(`LinkYun API 根地址（直接 Enter 使用 ${DEFAULT_API_BASE}）: `)).trim()
      apiBase = b ? normalizeApiBase(b) : DEFAULT_API_BASE
    } else {
      console.error(`API 根地址: ${apiBase}`)
    }

    let apiKey = opts.forceLogin ? undefined : env.LINKYUN_API_KEY?.trim()
    let workspaceCode = opts.workspaceCode?.trim() || env.LINKYUN_WORKSPACE_CODE?.trim()
    let workspaceName: string | undefined
    let headers = apiKey ? buildHeaders(apiKey, workspaceCode) : {}
    let agents = apiKey ? await listAgents(apiBase, headers) : null
    if (!agents) {
      if (apiKey && !opts.forceLogin) {
        console.error('（提示）.env.local 中的登录信息不可用，切换到重新登录。')
      }
      process.exitCode = undefined
      const login = await promptLogin(apiBase, rl)
      if (!login) return
      apiKey = login.apiKey
      workspaceCode = opts.workspaceCode?.trim() || login.workspaceCode
      workspaceName = login.workspaceName
      headers = buildHeaders(apiKey, workspaceCode)
      agents = await listAgents(apiBase, headers)
      if (!agents) return
    } else {
      await rl.close()
      console.error('✓ 使用 .env.local 中的 LinkYun 登录信息')
    }
    if (workspaceCode) {
      console.error(`工作空间: ${workspaceCode}${workspaceName ? ` (${workspaceName})` : ''}`)
    }

    const selected = await chooseAgent(agents, opts.agentCode?.trim() || env.LINKYUN_AGENT_CODE?.trim())
    if (!selected) return
    const agentCode = refDirNameFromAgent(selected.code, selected.id)

    const detailUrl = apiV1(apiBase, `/agents/${selected.id}`)
    const detailRes = await getJson(detailUrl, headers)
    if (!detailRes.ok) {
      console.error(`获取 Agent 详情失败: ${apiErrorMessage(detailRes.json, detailRes.status)}`)
      process.exitCode = 2
      return
    }

    const agent = unwrapData<AgentDetail>(detailRes.json)
    await ensureLocalAgentDir(cwd)
    await saveLocalEnv(cwd, {
      LINKYUN_API_BASE: apiBase,
      LINKYUN_API_KEY: apiKey,
      ...(workspaceCode ? { LINKYUN_WORKSPACE_CODE: workspaceCode } : {}),
      LINKYUN_AGENT_CODE: agentCode,
    })
    console.error(`✓ 已保存同步配置到 ${join(cwd, ENV_LOCAL)}`)

    await syncAgentMetadata(cwd, apiBase, headers, agent)
    await syncAgentArchive(cwd, apiBase, headers, agentCode, localSessionBeforeSync, opts)
  } catch (e) {
    if ((e as Error).message === '已取消') {
      process.exitCode = 130
      return
    }
    throw e
  }
}
