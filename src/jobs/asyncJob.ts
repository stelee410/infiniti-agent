import { existsSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { appendSessionMessage } from '../session/file.js'

export function asyncJobFileName(id: string): string {
  return `${id}.json`
}

export async function appendAsyncJobLog(cwd: string, fileName: string, line: string): Promise<void> {
  try {
    const dir = join(cwd, '.infiniti-agent')
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, fileName), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* best effort diagnostics */
  }
}

export function currentCliWorkerInvocation(
  cwd: string,
  workerCommand: string,
  jobPath: string,
): { command: string; args: string[] } {
  const entry = process.argv[1]
  if (!entry) {
    return { command: 'infiniti-agent', args: [workerCommand, jobPath] }
  }
  if (/\.(tsx?|mts|cts)$/i.test(entry)) {
    const localTsx = join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
    return {
      command: existsSync(localTsx) ? localTsx : 'npx',
      args: existsSync(localTsx)
        ? [entry, workerCommand, jobPath]
        : ['tsx', entry, workerCommand, jobPath],
    }
  }
  return {
    command: process.execPath,
    args: [...process.execArgv, entry, workerCommand, jobPath],
  }
}

export async function appendAssistantSessionMessage(cwd: string, content: string): Promise<void> {
  if (!content.trim()) return
  await appendSessionMessage(cwd, { role: 'assistant', content })
}
