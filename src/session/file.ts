import { readFile, writeFile } from 'fs/promises'
import { SESSION_PATH } from '../paths.js'
import type { PersistedMessage } from '../llm/persisted.js'
import type { SessionFileV1 } from '../llm/persisted.js'

export async function loadSession(): Promise<SessionFileV1 | null> {
  try {
    const raw = await readFile(SESSION_PATH, 'utf8')
    const parsed = JSON.parse(raw) as SessionFileV1
    if (parsed?.version !== 1 || !Array.isArray(parsed.messages)) {
      return null
    }
    if (typeof parsed.cwd !== 'string') {
      parsed.cwd = process.cwd()
    }
    return parsed
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return null
    }
    throw e
  }
}

export async function saveSession(
  cwd: string,
  messages: PersistedMessage[],
): Promise<void> {
  const data: SessionFileV1 = {
    version: 1,
    cwd,
    messages,
  }
  await writeFile(SESSION_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}
