import { existsSync } from 'node:fs'
import { GLOBAL_CONFIG_PATH, localConfigPath } from '../paths.js'
import { upgradeConfig, type UpgradeResult } from '../config/io.js'

export type UpgradeCommandOptions = {
  global?: boolean
}

export type UpgradeCommandDeps = {
  existsSync: (path: string) => boolean
  upgradeConfig: (path: string) => Promise<UpgradeResult>
  paths: {
    globalConfigPath: string
    localConfigPath: (cwd: string) => string
  }
  log: (message: string) => void
  error: (message: string) => void
}

export function defaultUpgradeDeps(
  log: (message: string) => void = console.log,
  error: (message: string) => void = console.error,
): UpgradeCommandDeps {
  return {
    existsSync,
    upgradeConfig,
    paths: {
      globalConfigPath: GLOBAL_CONFIG_PATH,
      localConfigPath,
    },
    log,
    error,
  }
}

export function resolveUpgradeTargets(
  cwd: string,
  opts: UpgradeCommandOptions,
  deps: Pick<UpgradeCommandDeps, 'existsSync' | 'paths'>,
): { targets: string[]; missingGlobal: boolean } {
  const targets: string[] = []
  const localCfg = deps.paths.localConfigPath(cwd)
  const globalCfg = deps.paths.globalConfigPath

  if (opts.global) {
    if (deps.existsSync(globalCfg)) targets.push(globalCfg)
    return { targets, missingGlobal: targets.length === 0 }
  }

  if (deps.existsSync(localCfg)) targets.push(localCfg)
  if (deps.existsSync(globalCfg)) targets.push(globalCfg)
  return { targets, missingGlobal: false }
}

export async function runUpgradeCommand(
  cwd: string,
  opts: UpgradeCommandOptions,
  deps: UpgradeCommandDeps = defaultUpgradeDeps(),
): Promise<string[]> {
  const { targets, missingGlobal } = resolveUpgradeTargets(cwd, opts, deps)
  if (missingGlobal) {
    deps.log(`全局配置不存在: ${deps.paths.globalConfigPath}`)
    return []
  }
  if (!targets.length) {
    deps.log('未找到任何 config.json。请先运行: infiniti-agent init')
    return []
  }

  for (const target of targets) {
    try {
      const result = await deps.upgradeConfig(target)
      if (result.changed) {
        deps.log(`\n✓ 已升级: ${target}`)
        for (const c of result.changes) {
          deps.log(`  - ${c}`)
        }
      } else {
        deps.log(`✓ ${target} — 已是最新格式，无需升级`)
      }
    } catch (e) {
      deps.error(`✗ ${target}: ${(e as Error).message}`)
    }
  }
  return targets
}
