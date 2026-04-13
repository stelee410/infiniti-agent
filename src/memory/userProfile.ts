import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { localAgentDir } from '../paths.js'

export type ProfileTag = 'tech_stack' | 'communication' | 'workflow' | 'background' | 'other'

export type ProfileEntry = {
  id: string
  title: string
  body: string
  tag: ProfileTag
  createdAt: string
  updatedAt: string
}

export type ProfileStore = {
  version: 1
  entries: ProfileEntry[]
}

const MAX_TOTAL_CHARS = 3000
const PROFILE_FILE = 'user_profile.json'

function profileJsonPath(cwd: string): string {
  return join(localAgentDir(cwd), PROFILE_FILE)
}

function generateId(): string {
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export async function loadProfileStore(cwd: string): Promise<ProfileStore> {
  const p = profileJsonPath(cwd)
  try {
    const raw = await readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as ProfileStore
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
      return parsed
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') throw e
  }
  return { version: 1, entries: [] }
}

async function saveProfileStore(cwd: string, store: ProfileStore): Promise<void> {
  const p = profileJsonPath(cwd)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

function totalChars(entries: ProfileEntry[]): number {
  return entries.reduce((sum, e) => sum + e.title.length + e.body.length, 0)
}

export type ProfileAction =
  | { action: 'add'; title: string; body: string; tag?: ProfileTag }
  | { action: 'replace'; id: string; title?: string; body?: string; tag?: ProfileTag }
  | { action: 'remove'; id: string }
  | { action: 'list' }

export async function executeProfileAction(
  cwd: string,
  act: ProfileAction,
): Promise<{ ok: boolean; message?: string; error?: string; entries?: ProfileEntry[]; usage?: string }> {
  const store = await loadProfileStore(cwd)

  if (act.action === 'list') {
    const used = totalChars(store.entries)
    return {
      ok: true,
      entries: store.entries,
      usage: `${used}/${MAX_TOTAL_CHARS} chars (${store.entries.length} entries)`,
    }
  }

  if (act.action === 'remove') {
    const idx = store.entries.findIndex((e) => e.id === act.id)
    if (idx === -1) {
      return { ok: false, error: `未找到 ID=${act.id} 的画像条目` }
    }
    const removed = store.entries.splice(idx, 1)[0]!
    await saveProfileStore(cwd, store)
    return { ok: true, message: `已删除画像「${removed.title}」` }
  }

  if (act.action === 'replace') {
    const entry = store.entries.find((e) => e.id === act.id)
    if (!entry) {
      return { ok: false, error: `未找到 ID=${act.id} 的画像条目` }
    }
    const oldSize = entry.title.length + entry.body.length
    const newTitle = act.title ?? entry.title
    const newBody = act.body ?? entry.body
    const newSize = newTitle.length + newBody.length
    const currentTotal = totalChars(store.entries)
    if (currentTotal - oldSize + newSize > MAX_TOTAL_CHARS) {
      return {
        ok: false,
        error: `替换后会超出容量上限 (${currentTotal - oldSize + newSize}/${MAX_TOTAL_CHARS})。`,
        usage: `${currentTotal}/${MAX_TOTAL_CHARS} chars`,
      }
    }
    entry.title = newTitle
    entry.body = newBody
    if (act.tag) entry.tag = act.tag
    entry.updatedAt = new Date().toISOString()
    await saveProfileStore(cwd, store)
    return { ok: true, message: `已更新画像「${entry.title}」` }
  }

  // action === 'add'
  const body = act.body.trim()
  if (!body) {
    return { ok: false, error: 'body 不能为空' }
  }
  const title = act.title?.trim() || body.slice(0, 40)
  const newSize = title.length + body.length
  const currentTotal = totalChars(store.entries)
  if (currentTotal + newSize > MAX_TOTAL_CHARS) {
    return {
      ok: false,
      error: `添加后会超出容量上限 (${currentTotal + newSize}/${MAX_TOTAL_CHARS})。请先精简现有条目。`,
      usage: `${currentTotal}/${MAX_TOTAL_CHARS} chars`,
      entries: store.entries,
    }
  }

  const now = new Date().toISOString()
  const entry: ProfileEntry = {
    id: generateId(),
    title,
    body,
    tag: act.tag ?? 'other',
    createdAt: now,
    updatedAt: now,
  }
  store.entries.push(entry)
  await saveProfileStore(cwd, store)
  const used = totalChars(store.entries)
  return {
    ok: true,
    message: `已添加画像「${entry.title}」(ID: ${entry.id})`,
    usage: `${used}/${MAX_TOTAL_CHARS} chars (${store.entries.length} entries)`,
  }
}

export function profileToPromptBlock(store: ProfileStore): string {
  if (!store.entries.length) return ''
  const used = totalChars(store.entries)
  const pct = Math.round((used / MAX_TOTAL_CHARS) * 100)
  const header = `## 用户画像 [${pct}% — ${used}/${MAX_TOTAL_CHARS} chars]\n`
  const lines = store.entries.map((e) =>
    `- **[${e.tag}]** ${e.title}: ${e.body}`
  )
  return header + '\n' + lines.join('\n')
}
