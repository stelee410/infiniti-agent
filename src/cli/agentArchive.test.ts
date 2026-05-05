import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportAgentArchive, importAgentArchive } from './agentArchive.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'infiniti-agent-archive-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('agent archive import/export', () => {
  it('round-trips the local agent layout', async () => {
    const source = join(dir, 'source')
    const target = join(dir, 'target')
    await mkdir(join(source, '.infiniti-agent', 'jobs'), { recursive: true })
    await writeFile(join(source, 'SOUL.md'), '你是 Jess。\n')
    await writeFile(join(source, 'INFINITI.md'), '项目说明。\n')
    await writeFile(join(source, '.infiniti-agent', 'schedules.json'), '{"tasks":[]}\n')
    await writeFile(join(source, '.infiniti-agent', 'jobs', 'job.json'), '{"ok":true}\n')
    await mkdir(target, { recursive: true })

    const archive = join(dir, 'jess.agent')
    const exported = await exportAgentArchive(source, archive)
    expect(exported.entries).toContain('SOUL.md')
    expect(exported.entries).toContain('.infiniti-agent/schedules.json')

    const imported = await importAgentArchive(target, archive)
    expect(imported.overwritten).toBe(false)
    await expect(readFile(join(target, 'SOUL.md'), 'utf8')).resolves.toBe('你是 Jess。\n')
    await expect(readFile(join(target, '.infiniti-agent', 'jobs', 'job.json'), 'utf8')).resolves.toBe('{"ok":true}\n')
  })

  it('refuses to overwrite an existing layout without force in non-interactive mode', async () => {
    const source = join(dir, 'source')
    const target = join(dir, 'target')
    await mkdir(join(source, '.infiniti-agent'), { recursive: true })
    await mkdir(join(target, '.infiniti-agent'), { recursive: true })
    await writeFile(join(source, 'SOUL.md'), 'new\n')
    await writeFile(join(target, 'SOUL.md'), 'old\n')

    const archive = join(dir, 'jess.agent')
    await exportAgentArchive(source, archive)

    await expect(importAgentArchive(target, archive)).rejects.toThrow('已取消导入')
    await expect(readFile(join(target, 'SOUL.md'), 'utf8')).resolves.toBe('old\n')
  })

  it('force import clears stale layout files', async () => {
    const source = join(dir, 'source')
    const target = join(dir, 'target')
    await mkdir(join(source, '.infiniti-agent'), { recursive: true })
    await mkdir(join(target, '.infiniti-agent'), { recursive: true })
    await writeFile(join(source, 'SOUL.md'), 'new\n')
    await writeFile(join(target, 'INFINITI.md'), 'stale\n')

    const archive = join(dir, 'jess.agent')
    await exportAgentArchive(source, archive)
    const imported = await importAgentArchive(target, archive, { force: true })

    expect(imported.overwritten).toBe(true)
    expect(existsSync(join(target, 'INFINITI.md'))).toBe(false)
    await expect(readFile(join(target, 'SOUL.md'), 'utf8')).resolves.toBe('new\n')
  })

  it('excludes local-only generated assets and logs from export', async () => {
    const source = join(dir, 'source')
    await mkdir(join(source, '.infiniti-agent', 'inbox', 'assets'), { recursive: true })
    await mkdir(join(source, '.infiniti-agent', 'backups', 'sync', 'old'), { recursive: true })
    await writeFile(join(source, 'SOUL.md'), 'soul\n')
    await writeFile(join(source, '.env.local'), 'LINKYUN_API_KEY=secret\n')
    await writeFile(join(source, '.infiniti-agent', 'session.json'), '{"messages":[]}\n')
    await writeFile(join(source, '.infiniti-agent', 'infiniti-agent.log'), 'log\n')
    await writeFile(join(source, '.infiniti-agent', 'inbox', 'message.json'), '{"id":"msg"}\n')
    await writeFile(join(source, '.infiniti-agent', 'inbox', 'assets', 'large.png'), 'large\n')
    await writeFile(join(source, '.infiniti-agent', 'backups', 'sync', 'old', 'session.json'), '{}\n')

    const exported = await exportAgentArchive(source, join(dir, 'jess.agent'))

    expect(exported.entries).toContain('.infiniti-agent/session.json')
    expect(exported.entries).toContain('.infiniti-agent/inbox/message.json')
    expect(exported.entries).not.toContain('.infiniti-agent/infiniti-agent.log')
    expect(exported.entries).not.toContain('.infiniti-agent/inbox/assets/large.png')
    expect(exported.entries).not.toContain('.infiniti-agent/backups/sync/old/session.json')
    expect(exported.entries).not.toContain('.env.local')
  })

  it('preserves local-only inbox assets when force importing', async () => {
    const source = join(dir, 'source')
    const target = join(dir, 'target')
    await mkdir(join(source, '.infiniti-agent'), { recursive: true })
    await mkdir(join(target, '.infiniti-agent', 'inbox', 'assets'), { recursive: true })
    await mkdir(join(target, '.infiniti-agent', 'backups', 'sync', 'old'), { recursive: true })
    await writeFile(join(source, 'SOUL.md'), 'remote\n')
    await writeFile(join(source, '.infiniti-agent', 'session.json'), '{"messages":[]}\n')
    await writeFile(join(target, '.infiniti-agent', 'inbox', 'assets', 'keep.png'), 'asset\n')
    await writeFile(join(target, '.infiniti-agent', 'backups', 'sync', 'old', 'keep.json'), '{}\n')
    await writeFile(join(target, '.infiniti-agent', 'inbox', 'old.json'), '{"old":true}\n')

    const archive = join(dir, 'jess.agent')
    await exportAgentArchive(source, archive)
    await importAgentArchive(target, archive, { force: true })

    await expect(readFile(join(target, 'SOUL.md'), 'utf8')).resolves.toBe('remote\n')
    await expect(readFile(join(target, '.infiniti-agent', 'inbox', 'assets', 'keep.png'), 'utf8')).resolves.toBe('asset\n')
    await expect(readFile(join(target, '.infiniti-agent', 'backups', 'sync', 'old', 'keep.json'), 'utf8')).resolves.toBe('{}\n')
    expect(existsSync(join(target, '.infiniti-agent', 'inbox', 'old.json'))).toBe(false)
  })

  it('rejects archive entries that escape the current directory', async () => {
    const zip = new JSZip()
    zip.file('../outside.txt', 'bad')
    const archive = join(dir, 'bad.agent')
    await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }))

    await expect(importAgentArchive(dir, archive, { force: true })).rejects.toThrow('没有可导入')
    expect(existsSync(join(dir, '..', 'outside.txt'))).toBe(false)
  })
})
