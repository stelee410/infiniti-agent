import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureLocalAgentDir } from '../config/io.js'
import { localLinkyunRefDir } from '../paths.js'

const DEFAULT_API_BASE = 'https://api.linkyun.co'

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

async function getBinary(url: string): Promise<{ ok: boolean; status: number; buf: Buffer }> {
  const res = await fetch(url, { method: 'GET' })
  const ab = await res.arrayBuffer()
  return { ok: res.ok, status: res.status, buf: Buffer.from(ab) }
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
  /** 覆盖登录后默认空间，对应 X-Workspace-Code */
  workspaceCode?: string
}

export async function runLinkyunSync(cwd: string, opts: LinkyunSyncOptions = {}): Promise<void> {
  const rl = readline.createInterface({ input, output })
  const apiBaseInput = opts.apiBase?.trim()
  let apiBase = apiBaseInput ? normalizeApiBase(apiBaseInput) : DEFAULT_API_BASE

  try {
    console.error('\n=== infiniti-agent sync — 从 LinkYun 拉取 Agent 到本项目 ===\n')
    if (!apiBaseInput) {
      const b = (await rl.question(`LinkYun API 根地址（直接 Enter 使用 ${DEFAULT_API_BASE}）: `)).trim()
      apiBase = b ? normalizeApiBase(b) : DEFAULT_API_BASE
    } else {
      console.error(`API 根地址: ${apiBase}`)
    }

    const username = (await rl.question('用户名或邮箱: ')).trim()
    if (!username) {
      console.error('用户名不能为空')
      process.exitCode = 2
      return
    }

    await rl.close()

    const password = await readPasswordHidden('密码（不回显）: ')
    if (!password) {
      console.error('密码不能为空')
      process.exitCode = 2
      return
    }

    const loginUrl = apiV1(apiBase, '/auth/login')
    const loginRes = await postJson(loginUrl, { username, password })
    if (!loginRes.ok) {
      console.error(`登录失败: ${apiErrorMessage(loginRes.json, loginRes.status)}`)
      process.exitCode = 2
      return
    }

    const loginData = unwrapData<LoginData>(loginRes.json)
    const apiKey = loginData.api_key?.trim()
    if (!apiKey) {
      console.error('登录响应中缺少 api_key')
      process.exitCode = 2
      return
    }

    const workspaceCode =
      opts.workspaceCode?.trim() ||
      (typeof loginData.workspace?.code === 'string' ? loginData.workspace.code.trim() : '')

    const headers: Record<string, string> = { 'X-API-Key': apiKey }
    if (workspaceCode) {
      headers['X-Workspace-Code'] = workspaceCode
      console.error(`工作空间: ${workspaceCode}${loginData.workspace?.name ? ` (${loginData.workspace.name})` : ''}`)
    }

    const listUrl = new URL(apiV1(apiBase, '/agents'))
    listUrl.searchParams.set('limit', '500')
    const listRes = await getJson(listUrl.toString(), headers)
    if (!listRes.ok) {
      console.error(`列出 Agent 失败: ${apiErrorMessage(listRes.json, listRes.status)}`)
      process.exitCode = 2
      return
    }

    const listData = unwrapData<ListAgentsData>(listRes.json)
    const agents = listData.agents ?? []
    if (!agents.length) {
      console.error('当前账号下没有可用的 AI Agent。')
      process.exitCode = 2
      return
    }

    console.error('\n可选 Agent（输入序号）:\n')
    agents.forEach((a, i) => {
      const name = a.name ?? '(未命名)'
      const code = a.code ? ` · ${a.code}` : ''
      const st = a.status ? ` · ${a.status}` : ''
      console.error(`  ${i + 1}) [${a.id}] ${name}${code}${st}`)
    })

    const rl2 = readline.createInterface({ input, output })
    const pickRaw = (await rl2.question('\n请选择序号: ')).trim()
    rl2.close()

    const pick = Number(pickRaw)
    if (!Number.isFinite(pick) || pick < 1 || pick > agents.length) {
      console.error('无效序号')
      process.exitCode = 2
      return
    }

    const selected = agents[pick - 1]!
    const detailUrl = apiV1(apiBase, `/agents/${selected.id}`)
    const detailRes = await getJson(detailUrl, headers)
    if (!detailRes.ok) {
      console.error(`获取 Agent 详情失败: ${apiErrorMessage(detailRes.json, detailRes.status)}`)
      process.exitCode = 2
      return
    }

    const agent = unwrapData<AgentDetail>(detailRes.json)
    const promptText = pickPrompt(agent)
    if (!promptText) {
      console.error('该 Agent 没有可用的 system_prompt')
      process.exitCode = 2
      return
    }

    await ensureLocalAgentDir(cwd)
    const soulPath = join(cwd, 'SOUL.md')
    await writeFile(soulPath, promptText.endsWith('\n') ? promptText : `${promptText}\n`, 'utf8')

    const refDir = localLinkyunRefDir(cwd, refDirNameFromAgent(agent.code, agent.id))
    await mkdir(refDir, { recursive: true })

    const meta = agent.config?.metadata
    const avatarFile = metaString(meta, 'avatar')
    const sheetFile = metaString(meta, 'character_design_sheet')
    const specText = metaString(meta, 'character_design_spec')

    const downloads: string[] = []

    if (avatarFile) {
      const avatarUrl = withNoCacheTimestamp(apiV1(apiBase, `/avatars/${encodeURIComponent(avatarFile)}`))
      const img = await getBinary(avatarUrl)
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
      const img = await getBinary(sheetUrl)
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

    console.error(`\n✓ 已写入 SOUL.md: ${soulPath}`)
    console.error(`✓ 资源目录: ${refDir}`)
    if (downloads.length) {
      console.error('✓ 已保存文件:')
      for (const p of downloads) {
        console.error(`    ${p}`)
      }
    } else {
      console.error('（该 Agent 未配置头像或角色设定稿元数据，仅同步了提示词。）')
    }
  } catch (e) {
    if ((e as Error).message === '已取消') {
      process.exitCode = 130
      return
    }
    throw e
  }
}
