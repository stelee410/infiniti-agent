import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { localAgentDir } from '../paths.js'
import { join } from 'path'

export type MemoryTag = 'fact' | 'preference' | 'lesson' | 'convention' | 'environment' | 'other'

export type MemoryEntry = {
  id: string
  title: string
  body: string
  tag: MemoryTag
  createdAt: string
  updatedAt: string
}

export type MemoryStore = {
  version: 1
  entries: MemoryEntry[]
}

const MAX_TOTAL_CHARS = 6000
const MEMORY_FILE = 'memory.json'

function memoryJsonPath(cwd: string): string {
  return join(localAgentDir(cwd), MEMORY_FILE)
}

function generateId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}

export async function loadMemoryStore(cwd: string): Promise<MemoryStore> {
  const p = memoryJsonPath(cwd)
  try {
    const raw = await readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as MemoryStore
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
      return parsed
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') throw e
  }
  return { version: 1, entries: [] }
}

async function saveMemoryStore(cwd: string, store: MemoryStore): Promise<void> {
  const p = memoryJsonPath(cwd)
  await ensureDir(p)
  await writeFile(p, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

function totalChars(entries: MemoryEntry[]): number {
  return entries.reduce((sum, e) => sum + e.title.length + e.body.length, 0)
}

export type MemoryAction =
  | { action: 'add'; title: string; body: string; tag?: MemoryTag }
  | { action: 'replace'; id: string; title?: string; body?: string; tag?: MemoryTag }
  | { action: 'remove'; id: string }
  | { action: 'list' }

export async function executeMemoryAction(
  cwd: string,
  act: MemoryAction,
): Promise<{ ok: boolean; message?: string; error?: string; entries?: MemoryEntry[]; usage?: string }> {
  const store = await loadMemoryStore(cwd)

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
      return { ok: false, error: `未找到 ID=${act.id} 的记忆条目` }
    }
    const removed = store.entries.splice(idx, 1)[0]!
    await saveMemoryStore(cwd, store)
    return { ok: true, message: `已删除记忆「${removed.title}」` }
  }

  if (act.action === 'replace') {
    const entry = store.entries.find((e) => e.id === act.id)
    if (!entry) {
      return { ok: false, error: `未找到 ID=${act.id} 的记忆条目` }
    }
    const oldSize = entry.title.length + entry.body.length
    const newTitle = act.title ?? entry.title
    const newBody = act.body ?? entry.body
    const newSize = newTitle.length + newBody.length
    const currentTotal = totalChars(store.entries)
    if (currentTotal - oldSize + newSize > MAX_TOTAL_CHARS) {
      return {
        ok: false,
        error: `替换后会超出容量上限 (${currentTotal - oldSize + newSize}/${MAX_TOTAL_CHARS})。请先删除或精简其他条目。`,
        usage: `${currentTotal}/${MAX_TOTAL_CHARS} chars`,
      }
    }
    entry.title = newTitle
    entry.body = newBody
    if (act.tag) entry.tag = act.tag
    entry.updatedAt = new Date().toISOString()
    await saveMemoryStore(cwd, store)
    return { ok: true, message: `已更新记忆「${entry.title}」` }
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
      error: `添加后会超出容量上限 (${currentTotal + newSize}/${MAX_TOTAL_CHARS})。请先删除或精简现有条目再添加。`,
      usage: `${currentTotal}/${MAX_TOTAL_CHARS} chars`,
      entries: store.entries,
    }
  }

  const now = new Date().toISOString()
  const entry: MemoryEntry = {
    id: generateId(),
    title,
    body,
    tag: act.tag ?? 'other',
    createdAt: now,
    updatedAt: now,
  }
  store.entries.push(entry)
  await saveMemoryStore(cwd, store)
  const used = totalChars(store.entries)
  return {
    ok: true,
    message: `已添加记忆「${entry.title}」(ID: ${entry.id})`,
    usage: `${used}/${MAX_TOTAL_CHARS} chars (${store.entries.length} entries)`,
  }
}

export function memoryToPromptBlock(store: MemoryStore): string {
  if (!store.entries.length) return ''
  const used = totalChars(store.entries)
  const pct = Math.round((used / MAX_TOTAL_CHARS) * 100)
  const header = `## 长期记忆 [${pct}% — ${used}/${MAX_TOTAL_CHARS} chars, ${store.entries.length} entries]\n`
  const lines = store.entries.map((e) =>
    `- **[${e.tag}]** ${e.title} (ID: ${e.id})\n  ${e.body}`
  )
  return header + '\n' + lines.join('\n')
}
