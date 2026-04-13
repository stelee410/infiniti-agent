import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { recordSkillUsage, getSkillUsageSummary, loadUsageStore } from './tracker.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-tracker-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('recordSkillUsage', () => {
  it('records a usage entry', async () => {
    await recordSkillUsage(cwd, 'deploy-k8s', 7)
    const store = await loadUsageStore(cwd)
    expect(store.records).toHaveLength(1)
    expect(store.records[0]!.skillId).toBe('deploy-k8s')
    expect(store.records[0]!.toolCallCount).toBe(7)
  })

  it('accumulates multiple records', async () => {
    await recordSkillUsage(cwd, 'deploy-k8s', 3)
    await recordSkillUsage(cwd, 'deploy-k8s', 5)
    await recordSkillUsage(cwd, 'other-skill', 2)

    const store = await loadUsageStore(cwd)
    expect(store.records).toHaveLength(3)
  })
})

describe('getSkillUsageSummary', () => {
  it('returns zero for unused skill', async () => {
    const summary = await getSkillUsageSummary(cwd, 'nonexistent')
    expect(summary.totalUses).toBe(0)
    expect(summary.lastUsed).toBeNull()
  })

  it('returns correct counts', async () => {
    await recordSkillUsage(cwd, 'deploy-k8s', 3)
    await recordSkillUsage(cwd, 'deploy-k8s', 5)

    const summary = await getSkillUsageSummary(cwd, 'deploy-k8s')
    expect(summary.totalUses).toBe(2)
    expect(summary.lastUsed).toBeTruthy()
  })
})
