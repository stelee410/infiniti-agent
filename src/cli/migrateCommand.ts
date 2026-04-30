import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import {
  GLOBAL_CONFIG_PATH,
  GLOBAL_MEMORY_PATH,
  GLOBAL_SKILLS_DIR,
  localAgentDir,
  localConfigPath,
  localMemoryPath,
  localSkillsDir,
} from '../paths.js'

export type MigrateCommandDeps = {
  existsSync: (path: string) => boolean
  mkdir: typeof mkdir
  cp: typeof cp
  paths: {
    globalConfigPath: string
    globalMemoryPath: string
    globalSkillsDir: string
    localAgentDir: (cwd: string) => string
    localConfigPath: (cwd: string) => string
    localMemoryPath: (cwd: string) => string
    localSkillsDir: (cwd: string) => string
  }
  log: (message: string) => void
}

export function defaultMigrateDeps(log: (message: string) => void = console.log): MigrateCommandDeps {
  return {
    existsSync,
    mkdir,
    cp,
    paths: {
      globalConfigPath: GLOBAL_CONFIG_PATH,
      globalMemoryPath: GLOBAL_MEMORY_PATH,
      globalSkillsDir: GLOBAL_SKILLS_DIR,
      localAgentDir,
      localConfigPath,
      localMemoryPath,
      localSkillsDir,
    },
    log,
  }
}

export async function runMigrateCommand(
  cwd: string,
  deps: MigrateCommandDeps = defaultMigrateDeps(),
): Promise<number> {
  const localDir = deps.paths.localAgentDir(cwd)
  await deps.mkdir(localDir, { recursive: true })
  let copied = 0

  const localCfg = deps.paths.localConfigPath(cwd)
  if (deps.existsSync(deps.paths.globalConfigPath) && !deps.existsSync(localCfg)) {
    await deps.cp(deps.paths.globalConfigPath, localCfg)
    deps.log(`✓ config.json → ${localCfg}`)
    copied++
  }

  const localMemory = deps.paths.localMemoryPath(cwd)
  if (deps.existsSync(deps.paths.globalMemoryPath) && !deps.existsSync(localMemory)) {
    await deps.cp(deps.paths.globalMemoryPath, localMemory)
    deps.log(`✓ memory.md → ${localMemory}`)
    copied++
  }

  if (deps.existsSync(deps.paths.globalSkillsDir)) {
    const localSkills = deps.paths.localSkillsDir(cwd)
    if (!deps.existsSync(localSkills)) {
      await deps.cp(deps.paths.globalSkillsDir, localSkills, { recursive: true })
      deps.log(`✓ skills/ → ${localSkills}`)
      copied++
    }
  }

  if (copied === 0) {
    deps.log('无需迁移（本地已存在或全局无配置）。如需首次配置请运行: infiniti-agent init')
  } else {
    deps.log(`\n已迁移 ${copied} 项到 ${localDir}`)
    deps.log('后续所有 session、memory、skills 均在此目录下独立运行。')
  }
  return copied
}
