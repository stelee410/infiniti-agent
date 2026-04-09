import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { localSessionPath } from '../paths.js'
import type { PersistedMessage } from '../llm/persisted.js'
import type { SessionFileV1 } from '../llm/persisted.js'

export async function loadSession(cwd: string): Promise<SessionFileV1 | null> {
  const sessionPath = localSessionPath(cwd)
  try {
    const raw = await readFile(sessionPath, 'utf8')
    const parsed = JSON.parse(raw) as SessionFileV1
    if (parsed?.version !== 1 || !Array.isArray(parsed.messages)) {
      return null
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
  const sessionPath = localSessionPath(cwd)
  await mkdir(dirname(sessionPath), { recursive: true })
  const data: SessionFileV1 = {
    version: 1,
    cwd,
    messages,
  }
  await writeFile(sessionPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}
