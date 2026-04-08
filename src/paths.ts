import { createHash } from 'crypto'
import { homedir } from 'os'
import { basename, join } from 'path'

export const INFINITI_AGENT_DIR = join(homedir(), '.infiniti-agent')
export const CONFIG_PATH = join(INFINITI_AGENT_DIR, 'config.json')
export const MEMORY_PATH = join(INFINITI_AGENT_DIR, 'memory.md')
export const SKILLS_DIR = join(INFINITI_AGENT_DIR, 'skills')
export const SESSIONS_DIR = join(INFINITI_AGENT_DIR, 'sessions')
export const ERROR_LOG_PATH = join(INFINITI_AGENT_DIR, 'error.log')

/** 按工作目录隔离的 session 文件路径 */
export function sessionPathForCwd(cwd: string): string {
  const hash = createHash('md5').update(cwd).digest('hex').slice(0, 8)
  const name = basename(cwd).replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(SESSIONS_DIR, `${name}-${hash}.json`)
}

export function expandUserPath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1).replace(/^\//, '') || '')
  }
  return p
}
