import { mkdir, readFile, writeFile, appendFile } from 'fs/promises'
import { dirname } from 'path'
import { localMemoryPath } from '../paths.js'

const MAX_INJECT_CHARS = 12000

async function ensureMemoryFile(cwd: string): Promise<string> {
  const memPath = localMemoryPath(cwd)
  await mkdir(dirname(memPath), { recursive: true })
  try {
    await readFile(memPath, 'utf8')
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      await writeFile(
        memPath,
        '# 长期记忆\n\n> 由 infiniti-agent 与会话工具维护；会注入到系统提示中。\n\n',
        'utf8',
      )
    } else {
      throw e
    }
  }
  return memPath
}

export async function readMemoryForPrompt(cwd: string): Promise<string> {
  const memPath = await ensureMemoryFile(cwd)
  const raw = await readFile(memPath, 'utf8')
  const t = raw.trim()
  if (!t) {
    return ''
  }
  return t.length > MAX_INJECT_CHARS
    ? `${t.slice(0, MAX_INJECT_CHARS)}\n\n…(已截断，见 ${memPath})`
    : t
}

export type MemoryAppend = {
  title?: string
  body: string
}

export async function appendMemoryEntry(cwd: string, entry: MemoryAppend): Promise<void> {
  const memPath = await ensureMemoryFile(cwd)
  const ts = new Date().toISOString()
  const head = entry.title?.trim()
    ? `\n## ${entry.title.trim()} (${ts})\n\n`
    : `\n## ${ts}\n\n`
  await appendFile(memPath, `${head}${entry.body.trim()}\n`, 'utf8')
}

export async function mergeMemoryBlob(cwd: string, sectionTitle: string, blob: string): Promise<void> {
  const memPath = await ensureMemoryFile(cwd)
  const ts = new Date().toISOString()
  await appendFile(
    memPath,
    `\n### 整合: ${sectionTitle} (${ts})\n\n${blob.trim()}\n`,
    'utf8',
  )
}
