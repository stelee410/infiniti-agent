import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { InfinitiConfig } from '../config/types.js'
import { executeMemoryAction } from '../memory/structured.js'
import { executeProfileAction } from '../memory/userProfile.js'
import { buildSystemWithMemory } from './systemBuilder.js'
import { MEMORY_NUDGE_SECTION } from './memoryNudge.js'

vi.mock('../llm/oneShotCompletion.js', () => ({
  oneShotTextCompletion: vi.fn(async () => '{}'),
}))

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-sysbuilder-test-'))
  // create empty SOUL.md so loadAgentPromptDocs has deterministic content
  await writeFile(join(cwd, 'SOUL.md'), '# 测试 SOUL\n本测试用 SOUL。', 'utf8')
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const config: InfinitiConfig = {
  version: 1,
  llm: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-test',
    apiKey: 'sk-test',
  },
}

describe('buildSystemWithMemory', () => {
  it('always includes SOUL/persona content', async () => {
    const result = await buildSystemWithMemory(config, cwd)
    expect(result).toContain('测试 SOUL')
  })

  it('always includes current time section', async () => {
    const result = await buildSystemWithMemory(config, cwd)
    expect(result).toContain('## 当前时间')
    expect(result).toContain('当前本地时间')
    expect(result).toContain('当前 ISO 时间')
    expect(result).toContain('当前时区')
  })

  it('always includes MEMORY_NUDGE_SECTION at the tail', async () => {
    const result = await buildSystemWithMemory(config, cwd)
    expect(result).toContain(MEMORY_NUDGE_SECTION)
  })

  it('does NOT include memory block when memory store is empty', async () => {
    const result = await buildSystemWithMemory(config, cwd)
    expect(result).not.toContain('## 长期记忆')
  })

  it('includes memory block when memory store has entries', async () => {
    await executeMemoryAction(cwd, {
      action: 'add',
      title: '用户用 TS',
      body: '本项目使用 TypeScript 5.7',
      tag: 'fact',
    })
    const result = await buildSystemWithMemory(config, cwd)
    expect(result).toContain('## 长期记忆')
    expect(result).toContain('用户用 TS')
    expect(result).toContain('本项目使用 TypeScript 5.7')
  })

  it('does NOT include profile block when profile store empty', async () => {
    const result = await buildSystemWithMemory(config, cwd)
    expect(result).not.toMatch(/## 用户画像/)
  })

  it('includes profile block when profile store has entries', async () => {
    await executeProfileAction(cwd, {
      action: 'add',
      title: '偏好简洁',
      body: '用户喜欢简洁直接的回答',
      tag: 'communication',
    })
    const result = await buildSystemWithMemory(config, cwd)
    expect(result).toContain('偏好简洁')
  })

  it('does NOT include retrieved-memory block when query is empty/undefined', async () => {
    const result = await buildSystemWithMemory(config, cwd, undefined, '')
    expect(result).not.toContain('## 相关长期记忆')
  })

  it('coordinator.retrieveRelevantMemory is used when provided AND query non-empty', async () => {
    const retrieve = vi.fn(async (q: string) => `RETRIEVED_FOR_${q}`)
    const coordinator = {
      loadMemoryStore: vi.fn(async () => ({
        version: 1 as const,
        entries: [],
      })),
      loadProfileStore: vi.fn(async () => ({
        version: 1 as const,
        entries: [],
      })),
      retrieveRelevantMemory: retrieve,
    }
    const result = await buildSystemWithMemory(config, cwd, coordinator, 'how does X work')
    expect(retrieve).toHaveBeenCalledWith('how does X work')
    expect(result).toContain('RETRIEVED_FOR_how does X work')
  })

  it('coordinator overrides direct store loading for memory and profile', async () => {
    // Even though disk has memory, coordinator returns its own
    await executeMemoryAction(cwd, {
      action: 'add',
      title: 'DISK ENTRY',
      body: 'should not appear',
      tag: 'fact',
    })
    const coordinator = {
      loadMemoryStore: vi.fn(async () => ({
        version: 1 as const,
        entries: [
          {
            id: 'm_x',
            title: 'COORDINATOR ENTRY',
            body: 'this appears instead',
            tag: 'fact' as const,
            createdAt: '2025-01-01',
            updatedAt: '2025-01-01',
          },
        ],
      })),
      loadProfileStore: vi.fn(async () => ({
        version: 1 as const,
        entries: [],
      })),
    }
    const result = await buildSystemWithMemory(config, cwd, coordinator)
    expect(result).toContain('COORDINATOR ENTRY')
    expect(result).not.toContain('DISK ENTRY')
    expect(coordinator.loadMemoryStore).toHaveBeenCalled()
    expect(coordinator.loadProfileStore).toHaveBeenCalled()
  })

  it('section order: persona → time → memory → profile → nudge', async () => {
    await executeMemoryAction(cwd, {
      action: 'add',
      title: 'MEM_MARKER',
      body: 'memory body',
      tag: 'fact',
    })
    await executeProfileAction(cwd, {
      action: 'add',
      title: 'PROFILE_MARKER',
      body: 'profile body',
      tag: 'communication',
    })
    const result = await buildSystemWithMemory(config, cwd)
    const ix = (s: string) => result.indexOf(s)
    expect(ix('测试 SOUL')).toBeLessThan(ix('## 当前时间'))
    expect(ix('## 当前时间')).toBeLessThan(ix('MEM_MARKER'))
    expect(ix('MEM_MARKER')).toBeLessThan(ix('PROFILE_MARKER'))
    expect(ix('PROFILE_MARKER')).toBeLessThan(ix(MEMORY_NUDGE_SECTION))
  })

  it('Skills block appears when SOUL-level skills present', async () => {
    // Create a skill directory: .infiniti-agent/skills/<name>/SKILL.md
    const skillDir = join(cwd, '.infiniti-agent', 'skills', 'test-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: test skill description\n---\n\nbody',
      'utf8',
    )
    const result = await buildSystemWithMemory(config, cwd)
    // Skills section header (loose match — exact heading lives in skillsToSystemBlock)
    expect(result.toLowerCase()).toContain('skill')
  })
})
