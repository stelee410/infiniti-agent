import { mkdir, readFile, writeFile, appendFile } from 'fs/promises'
import { MEMORY_PATH, INFINITI_AGENT_DIR } from '../paths.js'

const MAX_INJECT_CHARS = 12000

export async function ensureMemoryFile(): Promise<void> {
  await mkdir(INFINITI_AGENT_DIR, { recursive: true, mode: 0o700 })
  try {
    await readFile(MEMORY_PATH, 'utf8')
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      await writeFile(
        MEMORY_PATH,
        '# 长期记忆\n\n> 由 infiniti-agent 与会话工具维护；会注入到系统提示中。\n\n',
        'utf8',
      )
    } else {
      throw e
    }
  }
}

export async function readMemoryForPrompt(): Promise<string> {
  await ensureMemoryFile()
  const raw = await readFile(MEMORY_PATH, 'utf8')
  const t = raw.trim()
  if (!t) {
    return ''
  }
  return t.length > MAX_INJECT_CHARS
    ? `${t.slice(0, MAX_INJECT_CHARS)}\n\n…(已截断，见 ${MEMORY_PATH})`
    : t
}

export type MemoryAppend = {
  title?: string
  body: string
}

/** 追加一条带时间戳的段落，便于后续 loop 模式做整合。 */
export async function appendMemoryEntry(entry: MemoryAppend): Promise<void> {
  await ensureMemoryFile()
  const ts = new Date().toISOString()
  const head = entry.title?.trim()
    ? `\n## ${entry.title.trim()} (${ts})\n\n`
    : `\n## ${ts}\n\n`
  await appendFile(MEMORY_PATH, `${head}${entry.body.trim()}\n`, 'utf8')
}

/** 将多段草稿合并进主文件（简单拼接）；复杂整合可后续接模型调用。 */
export async function mergeMemoryBlob(sectionTitle: string, blob: string): Promise<void> {
  await ensureMemoryFile()
  const ts = new Date().toISOString()
  await appendFile(
    MEMORY_PATH,
    `\n### 整合: ${sectionTitle} (${ts})\n\n${blob.trim()}\n`,
    'utf8',
  )
}
