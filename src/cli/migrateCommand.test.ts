import { describe, expect, it, vi } from 'vitest'
import { runMigrateCommand, type MigrateCommandDeps } from './migrateCommand.js'

function deps(existing: Set<string>, logs: string[] = []): MigrateCommandDeps {
  return {
    existsSync: (path) => existing.has(path),
    mkdir: vi.fn(async () => undefined) as unknown as MigrateCommandDeps['mkdir'],
    cp: vi.fn(async () => undefined) as unknown as MigrateCommandDeps['cp'],
    paths: {
      globalConfigPath: '/global/config.json',
      globalMemoryPath: '/global/memory.md',
      globalSkillsDir: '/global/skills',
      localAgentDir: (cwd) => `${cwd}/.infiniti-agent`,
      localConfigPath: (cwd) => `${cwd}/.infiniti-agent/config.json`,
      localMemoryPath: (cwd) => `${cwd}/.infiniti-agent/memory.md`,
      localSkillsDir: (cwd) => `${cwd}/.infiniti-agent/skills`,
    },
    log: (message) => logs.push(message),
  }
}

describe('runMigrateCommand', () => {
  it('copies missing local config, memory, and skills from global state', async () => {
    const logs: string[] = []
    const d = deps(new Set(['/global/config.json', '/global/memory.md', '/global/skills']), logs)

    const copied = await runMigrateCommand('/project', d)

    expect(copied).toBe(3)
    expect(d.mkdir).toHaveBeenCalledWith('/project/.infiniti-agent', { recursive: true })
    expect(d.cp).toHaveBeenCalledWith('/global/config.json', '/project/.infiniti-agent/config.json')
    expect(d.cp).toHaveBeenCalledWith('/global/memory.md', '/project/.infiniti-agent/memory.md')
    expect(d.cp).toHaveBeenCalledWith('/global/skills', '/project/.infiniti-agent/skills', { recursive: true })
    expect(logs.at(-1)).toContain('后续所有 session')
  })

  it('does not overwrite existing local files', async () => {
    const logs: string[] = []
    const d = deps(new Set([
      '/global/config.json',
      '/global/memory.md',
      '/global/skills',
      '/project/.infiniti-agent/config.json',
      '/project/.infiniti-agent/memory.md',
      '/project/.infiniti-agent/skills',
    ]), logs)

    const copied = await runMigrateCommand('/project', d)

    expect(copied).toBe(0)
    expect(d.cp).not.toHaveBeenCalled()
    expect(logs).toEqual(['无需迁移（本地已存在或全局无配置）。如需首次配置请运行: infiniti-agent init'])
  })
})
