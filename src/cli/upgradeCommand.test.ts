import { describe, expect, it, vi } from 'vitest'
import { resolveUpgradeTargets, runUpgradeCommand, type UpgradeCommandDeps } from './upgradeCommand.js'

function deps(existing: Set<string>, logs: string[] = [], errors: string[] = []): UpgradeCommandDeps {
  return {
    existsSync: (path) => existing.has(path),
    upgradeConfig: vi.fn(async (path: string) => ({
      changed: path.includes('local'),
      path,
      changes: path.includes('local') ? ['migrated llm profiles'] : [],
    })),
    paths: {
      globalConfigPath: '/global/config.json',
      localConfigPath: (cwd) => `${cwd}/local-config.json`,
    },
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  }
}

describe('upgradeCommand', () => {
  it('resolves local and global targets by default', () => {
    const d = deps(new Set(['/project/local-config.json', '/global/config.json']))
    expect(resolveUpgradeTargets('/project', {}, d)).toEqual({
      targets: ['/project/local-config.json', '/global/config.json'],
      missingGlobal: false,
    })
  })

  it('reports missing global config for --global', async () => {
    const logs: string[] = []
    const d = deps(new Set(), logs)
    const targets = await runUpgradeCommand('/project', { global: true }, d)
    expect(targets).toEqual([])
    expect(logs).toEqual(['全局配置不存在: /global/config.json'])
    expect(d.upgradeConfig).not.toHaveBeenCalled()
  })

  it('runs upgrades and prints changed/noop results', async () => {
    const logs: string[] = []
    const d = deps(new Set(['/project/local-config.json', '/global/config.json']), logs)

    const targets = await runUpgradeCommand('/project', {}, d)

    expect(targets).toEqual(['/project/local-config.json', '/global/config.json'])
    expect(d.upgradeConfig).toHaveBeenCalledTimes(2)
    expect(logs).toContain('\n✓ 已升级: /project/local-config.json')
    expect(logs).toContain('  - migrated llm profiles')
    expect(logs).toContain('✓ /global/config.json — 已是最新格式，无需升级')
  })

  it('logs per-target errors and continues', async () => {
    const errors: string[] = []
    const d = deps(new Set(['/project/local-config.json']), [], errors)
    d.upgradeConfig = vi.fn(async () => {
      throw new Error('bad json')
    })

    await runUpgradeCommand('/project', {}, d)

    expect(errors).toEqual(['✗ /project/local-config.json: bad json'])
  })
})
