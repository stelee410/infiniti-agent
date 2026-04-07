import { homedir } from 'os'
import { join } from 'path'

export const INFINITI_AGENT_DIR = join(homedir(), '.infiniti-agent')
export const CONFIG_PATH = join(INFINITI_AGENT_DIR, 'config.json')
export const MEMORY_PATH = join(INFINITI_AGENT_DIR, 'memory.md')
export const SKILLS_DIR = join(INFINITI_AGENT_DIR, 'skills')
export const SESSION_PATH = join(INFINITI_AGENT_DIR, 'session.json')

export function expandUserPath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1).replace(/^\//, '') || '')
  }
  return p
}
