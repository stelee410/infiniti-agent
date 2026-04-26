import { homedir } from 'os'
import { join } from 'path'

/** 全局共享目录（config fallback、migrate 来源） */
export const GLOBAL_AGENT_DIR = join(homedir(), '.infiniti-agent')
export const GLOBAL_CONFIG_PATH = join(GLOBAL_AGENT_DIR, 'config.json')
export const GLOBAL_SKILLS_DIR = join(GLOBAL_AGENT_DIR, 'skills')
export const GLOBAL_MEMORY_PATH = join(GLOBAL_AGENT_DIR, 'memory.md')

/** 项目级本地目录名 */
const LOCAL_DIR_NAME = '.infiniti-agent'

/** 项目级 .infiniti-agent/ 根目录 */
export function localAgentDir(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME)
}

export function localConfigPath(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'config.json')
}

export function localSkillsDir(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'skills')
}

export function localSessionPath(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'session.json')
}

export function localInboxDir(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'inbox')
}

export function localJobsDir(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'jobs')
}

export function localMemoryPath(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'memory.md')
}

export function localMemoryJsonPath(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'memory.json')
}

export function localUserProfilePath(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'user_profile.json')
}

export function localSessionDbPath(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'sessions.db')
}

export function localErrorLogPath(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'error.log')
}

/** LinkYun `sync` 资源目录：`.infiniti-agent/ref/<agentCode>/` */
export function localLinkyunRefDir(cwd: string, agentCode: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'ref', agentCode)
}

export function expandUserPath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1).replace(/^\//, '') || '')
  }
  return p
}
