import { describe, expect, it } from 'vitest'
import {
  cloneConfig,
  defaultImageProfile,
  defaultTtsConfig,
  ensureDefaultConfigNodes,
  ensureImageProfiles,
  ensureLlmProfiles,
  findMimoApiKey,
  inferSharedModelsDir,
  lines,
  num,
  splitLines,
  syncFlatLlm,
  text,
} from './configPanelModel.ts'

describe('configPanelModel primitive readers', () => {
  it('normalizes primitive field values without throwing', () => {
    expect(cloneConfig({ a: 1 })).toEqual({ a: 1 })
    expect(text('x')).toBe('x')
    expect(text(1)).toBe('')
    expect(num(1.5)).toBe('1.5')
    expect(num(Number.NaN, 'n/a')).toBe('n/a')
    expect(lines(['a', 1, 'b'])).toBe('a\nb')
    expect(splitLines('a, b\nc')).toEqual(['a', 'b', 'c'])
  })
})

describe('configPanelModel defaults', () => {
  it('finds Mimo API keys from TTS or matching LLM profiles', () => {
    expect(findMimoApiKey({ tts: { apiKey: 'tts-key' } })).toBe('tts-key')
    expect(findMimoApiKey({
      llm: {
        profiles: {
          main: { baseUrl: 'https://api.openai.com', apiKey: 'nope' },
          mimo: { baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiKey: 'mimo-key' },
        },
      },
    })).toBe('mimo-key')
  })

  it('builds provider-specific TTS defaults', () => {
    expect(defaultTtsConfig('', {})).toBeUndefined()
    expect(defaultTtsConfig('mimo', { llm: { baseUrl: 'https://xiaomimimo.com', apiKey: 'k' } })).toEqual(
      expect.objectContaining({ provider: 'mimo', apiKey: 'k', timeoutMs: 120000 }),
    )
    expect(defaultTtsConfig('voxcpm', {})).toEqual(
      expect.objectContaining({ provider: 'voxcpm', normalize: true, denoise: true }),
    )
    expect(defaultTtsConfig('minimax', { tts: { apiKey: 'm' } })).toEqual(
      expect.objectContaining({ provider: 'minimax', apiKey: 'm', voiceId: 'female-shaonv' }),
    )
  })

  it('creates and syncs LLM profiles from legacy flat config', () => {
    const cfg = {
      llm: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1-mini',
        apiKey: 'sk',
        disableTools: true,
      },
    }
    const profiles = ensureLlmProfiles(cfg)
    expect(profiles.main).toEqual(expect.objectContaining({ provider: 'openai', disableTools: true }))
    profiles.gate = { provider: 'openai', baseUrl: 'b', model: 'm', apiKey: 'k2' }
    cfg.llm.default = 'missing'
    cfg.llm.metaAgentProfile = 'missing'
    syncFlatLlm(cfg)
    expect(cfg.llm.default).toBe('main')
    expect(cfg.llm.metaAgentProfile).toBe('gate')
    expect(cfg.llm.model).toBe('gpt-4.1-mini')
  })

  it('migrates legacy image/avatar config into image profiles', () => {
    const cfg = {
      avatarGen: { provider: 'chatgpt-image', apiKey: 'a' },
      snap: { provider: 'nano-banana', apiKey: 's' },
      image: {},
    }
    const profiles = ensureImageProfiles(cfg)
    expect(profiles.avatar).toEqual(expect.objectContaining({ provider: 'gpt-image-2', apiKey: 'a' }))
    expect(profiles.snap).toEqual(expect.objectContaining({ provider: 'nano-banana', apiKey: 's' }))
    expect(cfg.image.avatarGenProfile).toBe('avatar')
    expect(defaultImageProfile('gpt-image-2')).toEqual(expect.objectContaining({ imageSize: '1024x1536' }))
  })

  it('fills default config nodes and model paths from cwd', () => {
    const cfg: Record<string, any> = {}
    ensureDefaultConfigNodes(cfg, '/Users/me/Dev/project')
    expect(cfg.version).toBe(1)
    expect(cfg.liveUi.port).toBe(8080)
    expect(cfg.asr.model).toContain('/Users/me/Dev/models/')
    expect(cfg.seedance).toEqual(expect.objectContaining({ provider: 'volcengine', duration: 5 }))
    expect(cfg.avatarGen).toBeUndefined()
    expect(inferSharedModelsDir('/tmp/project')).toBe('/tmp/project/models')
  })
})
