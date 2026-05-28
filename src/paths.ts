import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** 全局共享目录（config fallback、migrate 来源） */
export const GLOBAL_AGENT_DIR = join(homedir(), '.infiniti-agent')
export const GLOBAL_CONFIG_PATH = join(GLOBAL_AGENT_DIR, 'config.json')
export const GLOBAL_SKILLS_DIR = join(GLOBAL_AGENT_DIR, 'skills')
export const GLOBAL_MEMORY_PATH = join(GLOBAL_AGENT_DIR, 'memory.md')

/** 项目级本地目录名 */
const LOCAL_DIR_NAME = '.infiniti-agent'

/** 主记忆名：始终指向顶层 .infiniti-agent/（也是唯一可同步的记忆）。 */
export const MAIN_MEMORY_NAME = 'main'

/** 项目级 .infiniti-agent/ 根目录（共享基础设施：config / skills / schedules / sync 等）。 */
export function localAgentDir(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME)
}

/** 记忆切换状态文件：记录当前激活记忆与已注册记忆列表。 */
export function memoryStatePath(cwd: string): string {
  return join(localAgentDir(cwd), 'memory-state.json')
}

/** 命名记忆的根目录：.infiniti-agent/memories/ */
export function memoriesRootDir(cwd: string): string {
  return join(localAgentDir(cwd), 'memories')
}

/** 单个命名记忆目录：.infiniti-agent/memories/<name>/ */
export function namedMemoryDir(cwd: string, name: string): string {
  return join(memoriesRootDir(cwd), name)
}

// 进程级激活记忆缓存。路径解析函数是同步的，因此用同步读取 + 缓存避免每次落盘。
// workspace 模块在切换/写入时通过 setActiveMemoryCache 保持同步。
let activeMemoryCache: string | null = null

/** 同步获取当前激活记忆名；首次惰性从 memory-state.json 读取，缺失/损坏回退 main。 */
export function getActiveMemoryName(cwd: string): string {
  if (activeMemoryCache !== null) return activeMemoryCache
  try {
    const parsed = JSON.parse(readFileSync(memoryStatePath(cwd), 'utf8')) as { current?: unknown }
    activeMemoryCache = typeof parsed.current === 'string' && parsed.current ? parsed.current : MAIN_MEMORY_NAME
  } catch {
    activeMemoryCache = MAIN_MEMORY_NAME
  }
  return activeMemoryCache
}

/** 更新进程级缓存（workspace 写状态文件后调用，确保同进程内路径解析立即生效）。 */
export function setActiveMemoryCache(name: string): void {
  activeMemoryCache = name
}

/** 测试辅助：清空缓存以便重新从磁盘加载。 */
export function resetActiveMemoryCache(): void {
  activeMemoryCache = null
}

/**
 * 当前激活记忆的根目录——会话/潜意识/记忆/梦境等运行时存储都基于此。
 * main → 顶层 .infiniti-agent/（向后兼容、可同步）；命名记忆 → memories/<name>/。
 * 若命名记忆目录已不存在则自愈回退到 main。
 */
export function activeMemoryDir(cwd: string): string {
  const name = getActiveMemoryName(cwd)
  if (name === MAIN_MEMORY_NAME) return localAgentDir(cwd)
  const dir = namedMemoryDir(cwd, name)
  if (!existsSync(dir)) return localAgentDir(cwd)
  return dir
}

/** 主记忆 session.json 的固定路径（sync 专用，始终指向 main，与激活记忆无关）。 */
export function mainSessionPath(cwd: string): string {
  return join(localAgentDir(cwd), 'session.json')
}

/** 本地工作产物根目录：顶层共享、不随 memory switch 隔离、不随 sync 上传。 */
export function localWorkspaceDir(cwd: string): string {
  return join(localAgentDir(cwd), 'workspace')
}

/** 录音落盘目录：.infiniti-agent/workspace/recordings/ */
export function recordingsDir(cwd: string): string {
  return join(localWorkspaceDir(cwd), 'recordings')
}

export function localConfigPath(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'config.json')
}

export function localSkillsDir(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'skills')
}

export function localSessionPath(cwd: string): string {
  return join(activeMemoryDir(cwd), 'session.json')
}

export function localInboxDir(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'inbox')
}

export function localSchedulesPath(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'schedules.json')
}

export function localJobsDir(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'jobs')
}

export function localH5AppletsDir(cwd: string): string {
  return join(cwd, LOCAL_DIR_NAME, 'h5-applets')
}

export function localDreamsDir(cwd: string): string {
  return join(activeMemoryDir(cwd), 'dreams')
}

export function localMemoryPath(cwd: string): string {
  return join(activeMemoryDir(cwd), 'memory.md')
}

export function localMemoryJsonPath(cwd: string): string {
  return join(activeMemoryDir(cwd), 'memory.json')
}

export function localUserProfilePath(cwd: string): string {
  return join(activeMemoryDir(cwd), 'user_profile.json')
}

export function localSessionDbPath(cwd: string): string {
  return join(activeMemoryDir(cwd), 'sessions.db')
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
