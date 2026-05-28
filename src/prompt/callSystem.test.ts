import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { InfinitiConfig } from '../config/types.js'
import { buildCallSystem } from './callSystem.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-callsys-test-'))
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

describe('buildCallSystem', () => {
  it('always includes SOUL persona', async () => {
    const result = await buildCallSystem(config, cwd, undefined, [])
    expect(result).toContain('测试 SOUL')
  })

  it('always includes the call-mode contract section', async () => {
    const result = await buildCallSystem(config, cwd, undefined, [])
    expect(result).toContain('## 当前模式：电话通话')
    expect(result).toContain('TTS')
  })

  it('does NOT include augmentation block when buffer is empty', async () => {
    const result = await buildCallSystem(config, cwd, undefined, [])
    expect(result).not.toContain('## 后台补档')
  })

  it('includes augmentation block when buffer non-empty', async () => {
    const result = await buildCallSystem(config, cwd, undefined, [
      '用户喜欢猫',
      '上次提到要去爬山',
    ])
    expect(result).toContain('## 后台补档')
    expect(result).toContain('[1] 用户喜欢猫')
    expect(result).toContain('[2] 上次提到要去爬山')
  })

  it('does NOT add Markdown / list / code-block / expression instruction is present (口语化要求)', async () => {
    const result = await buildCallSystem(config, cwd, undefined, [])
    expect(result).toContain('口语化')
  })

  it('section order: persona → call contract → augmentation', async () => {
    const result = await buildCallSystem(config, cwd, undefined, ['增量1'])
    const ix = (s: string) => result.indexOf(s)
    expect(ix('测试 SOUL')).toBeLessThan(ix('## 当前模式：电话通话'))
    expect(ix('## 当前模式：电话通话')).toBeLessThan(ix('## 后台补档'))
  })
})
