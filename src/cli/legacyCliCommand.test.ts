import { describe, expect, it, vi } from 'vitest'
import type { InfinitiConfig } from '../config/types.js'
import {
  parseLegacyCliCommand,
  runLegacyCliCommand,
  type LegacyCliDeps,
  type LegacyCliIo,
} from './legacyCliCommand.js'

const cfg: InfinitiConfig = {
  version: 1,
  llm: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    apiKey: 'k',
  },
}

function throwingIo(errors: string[]): LegacyCliIo {
  return {
    error: (message) => errors.push(message),
    exit: (code) => {
      throw new Error(`exit:${code}`)
    },
  }
}

function deps(overrides: Partial<LegacyCliDeps> = {}): LegacyCliDeps {
  return {
    cwd: '/tmp/project',
    disableThinking: false,
    configExistsSync: vi.fn(() => true),
    loadConfig: vi.fn(async () => cfg),
    applyThinkingOverride: vi.fn((c) => c),
    runCliPrompt: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('legacyCliCommand', () => {
  it('parses --cli prompt compatibility form', () => {
    expect(parseLegacyCliCommand(['--cli', 'hello', 'world'])).toEqual({ prompt: 'hello world' })
    expect(parseLegacyCliCommand(['chat'])).toBeNull()
  })

  it('runs one-shot prompt with loaded config', async () => {
    const d = deps()
    await runLegacyCliCommand({ prompt: 'hello' }, d, throwingIo([]))
    expect(d.loadConfig).toHaveBeenCalledWith('/tmp/project')
    expect(d.applyThinkingOverride).toHaveBeenCalledWith(cfg, false)
    expect(d.runCliPrompt).toHaveBeenCalledWith(cfg, 'hello')
  })

  it('rejects empty prompt and missing config', async () => {
    const errors: string[] = []
    await expect(runLegacyCliCommand({ prompt: '' }, deps(), throwingIo(errors))).rejects.toThrow('exit:2')
    expect(errors[0]).toContain('用法')

    const missingErrors: string[] = []
    await expect(runLegacyCliCommand(
      { prompt: 'hello' },
      deps({ configExistsSync: vi.fn(() => false) }),
      throwingIo(missingErrors),
    )).rejects.toThrow('exit:2')
    expect(missingErrors[0]).toContain('尚未配置')
  })

  it('reports prompt execution failures', async () => {
    const errors: string[] = []
    await expect(runLegacyCliCommand(
      { prompt: 'hello' },
      deps({ runCliPrompt: vi.fn(async () => { throw new Error('model down') }) }),
      throwingIo(errors),
    )).rejects.toThrow('exit:2')
    expect(errors).toEqual(['model down'])
  })
})
