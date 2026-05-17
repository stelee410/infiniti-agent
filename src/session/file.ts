import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { localSessionPath } from '../paths.js'
import type { PersistedMessage } from '../llm/persisted.js'
import type { SessionFileV1 } from '../llm/persisted.js'
import { dropEmptyAssistantTurns, truncateToolResults, withMessageTimestamps } from '../llm/persisted.js'

export async function loadSession(cwd: string): Promise<SessionFileV1 | null> {
  const sessionPath = localSessionPath(cwd)
  try {
    const raw = await readFile(sessionPath, 'utf8')
    const parsed = JSON.parse(raw) as SessionFileV1
    if (parsed?.version !== 1 || !Array.isArray(parsed.messages)) {
      return null
    }
    // Self-heal: strip empty assistant turns that pre-fix sessions may contain.
    parsed.messages = dropEmptyAssistantTurns(parsed.messages)
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
    messages: withMessageTimestamps(truncateToolResults(dropEmptyAssistantTurns(messages))),
  }
  await writeFile(sessionPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

async function acquireSessionLock(cwd: string): Promise<() => Promise<void>> {
  const sessionDir = dirname(localSessionPath(cwd))
  await mkdir(sessionDir, { recursive: true })
  const lockDir = join(sessionDir, 'session.lock')
  const deadline = Date.now() + 5000
  while (true) {
    try {
      await mkdir(lockDir)
      return async () => {
        await rm(lockDir, { recursive: true, force: true })
      }
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'EEXIST') throw e
      try {
        const st = await stat(lockDir)
        if (Date.now() - st.mtimeMs > 10_000) {
          await rm(lockDir, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) {
        throw new Error('等待 session 写入锁超时')
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

export async function appendSessionMessage(
  cwd: string,
  message: PersistedMessage,
): Promise<void> {
  const release = await acquireSessionLock(cwd)
  try {
    const session = await loadSession(cwd)
    const messages: PersistedMessage[] = session?.messages ?? []
    await saveSession(cwd, [...messages, message])
  } finally {
    await release()
  }
}
