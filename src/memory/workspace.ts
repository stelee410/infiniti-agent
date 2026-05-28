import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import {
  MAIN_MEMORY_NAME,
  memoriesRootDir,
  memoryStatePath,
  namedMemoryDir,
  setActiveMemoryCache,
} from '../paths.js'

/**
 * 记忆切换（memory switch）：每个记忆是一份隔离的工作区——独立的 session / 潜意识 /
 * 结构化记忆 / 用户画像 / 长期文档 / 梦境。
 *
 * - 主记忆 `main` 始终存在、不可删除，物理上就是顶层 .infiniti-agent/（也是唯一可同步的记忆）。
 * - 命名记忆存放在 .infiniti-agent/memories/<name>/。
 * - 当前激活记忆记录在 .infiniti-agent/memory-state.json。
 */

export type MemoryEntry = {
  name: string
  createdAt: string
}

export type MemoryState = {
  version: 1
  current: string
  memories: MemoryEntry[]
}

/** 合法记忆名：字母/数字开头，可含 - _，1~64 字符。`main` 由系统保留。 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export function isValidMemoryName(name: string): boolean {
  return NAME_RE.test(name)
}

function defaultState(): MemoryState {
  return { version: 1, current: MAIN_MEMORY_NAME, memories: [] }
}

export async function loadMemoryState(cwd: string): Promise<MemoryState> {
  try {
    const parsed = JSON.parse(await readFile(memoryStatePath(cwd), 'utf8')) as Partial<MemoryState>
    const memories = Array.isArray(parsed.memories)
      ? parsed.memories.filter(
          (m): m is MemoryEntry => !!m && typeof m.name === 'string' && m.name !== MAIN_MEMORY_NAME,
        )
      : []
    const current =
      typeof parsed.current === 'string' && parsed.current ? parsed.current : MAIN_MEMORY_NAME
    return { version: 1, current, memories }
  } catch {
    return defaultState()
  }
}

async function saveMemoryState(cwd: string, state: MemoryState): Promise<void> {
  await mkdir(memoriesRootDir(cwd), { recursive: true })
  await writeFile(memoryStatePath(cwd), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  setActiveMemoryCache(state.current)
}

/** 已注册的命名记忆名（不含 main）；同时合并磁盘上实际存在的目录，做一次自愈。 */
async function namedMemoryNames(cwd: string, state: MemoryState): Promise<string[]> {
  const names = new Set(state.memories.map((m) => m.name))
  try {
    const dirents = await readdir(memoriesRootDir(cwd), { withFileTypes: true })
    for (const d of dirents) {
      if (d.isDirectory() && isValidMemoryName(d.name)) names.add(d.name)
    }
  } catch {
    // memories/ 不存在 → 只有 main
  }
  return [...names].sort()
}

/** 所有记忆名，main 永远排第一。 */
export async function listMemoryNames(cwd: string): Promise<string[]> {
  const state = await loadMemoryState(cwd)
  return [MAIN_MEMORY_NAME, ...(await namedMemoryNames(cwd, state))]
}

export async function currentMemoryName(cwd: string): Promise<string> {
  const state = await loadMemoryState(cwd)
  const names = await listMemoryNames(cwd)
  // 自愈：指向已不存在的记忆时回退 main。
  return names.includes(state.current) ? state.current : MAIN_MEMORY_NAME
}

export async function memoryExists(cwd: string, name: string): Promise<boolean> {
  return (await listMemoryNames(cwd)).includes(name)
}

/** 新建一份空的命名记忆。 */
export async function createMemory(cwd: string, name: string): Promise<void> {
  if (name === MAIN_MEMORY_NAME) throw new Error('main 是主记忆，已存在，无需新建。')
  if (!isValidMemoryName(name)) {
    throw new Error('记忆名只能用字母/数字开头，含 - _，1~64 字符。')
  }
  if (await memoryExists(cwd, name)) throw new Error(`记忆「${name}」已存在。`)
  await mkdir(namedMemoryDir(cwd, name), { recursive: true })
  const state = await loadMemoryState(cwd)
  state.memories = [...state.memories, { name, createdAt: new Date().toISOString() }]
  await saveMemoryState(cwd, state)
}

/** 切换当前激活记忆（仅更新状态与进程缓存；会话/agent 的重载由调用方负责）。 */
export async function switchMemory(cwd: string, name: string): Promise<void> {
  if (!(await memoryExists(cwd, name))) {
    throw new Error(`记忆「${name}」不存在，用 /memory new ${name} 先新建。`)
  }
  const state = await loadMemoryState(cwd)
  state.current = name
  await saveMemoryState(cwd, state)
}

/** 删除命名记忆（main 不可删，当前激活记忆不可删）。 */
export async function deleteMemory(cwd: string, name: string): Promise<void> {
  if (name === MAIN_MEMORY_NAME) throw new Error('主记忆 main 不可删除。')
  if (!(await memoryExists(cwd, name))) throw new Error(`记忆「${name}」不存在。`)
  const state = await loadMemoryState(cwd)
  if (state.current === name) {
    throw new Error(`「${name}」是当前记忆，请先 /memory switch main 再删除。`)
  }
  await rm(namedMemoryDir(cwd, name), { recursive: true, force: true })
  state.memories = state.memories.filter((m) => m.name !== name)
  await saveMemoryState(cwd, state)
}
