import { describe, expect, it } from 'vitest'
import { applySetLiveAgentToConfig } from './setLiveAgent.js'
import type { InfinitiConfig } from '../config/types.js'

function minimalCfg(): InfinitiConfig {
  return {
    version: 1,
    llm: {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'x',
      apiKey: 'k',
    },
  }
}

describe('applySetLiveAgentToConfig', () => {
  it('sets spriteExpressions dir and preserves other liveUi fields', () => {
    const cfg: InfinitiConfig = {
      ...minimalCfg(),
      liveUi: {
        port: 9000,
        live2dModelName: 'mao_pro',
        spriteExpressions: { dir: './live2d-models/luna/expression', manifest: './old.json' },
      },
    }
    const out = applySetLiveAgentToConfig(cfg, 'Jess')
    expect(out.liveUi?.port).toBe(9000)
    expect(out.liveUi?.live2dModelName).toBe('mao_pro')
    expect(out.liveUi?.spriteExpressions?.dir).toBe('./live2d-models/jess/expression')
    expect(out.liveUi?.spriteExpressions?.manifest).toBeUndefined()
  })

  it('creates liveUi when absent', () => {
    const out = applySetLiveAgentToConfig(minimalCfg(), 'ab')
    expect(out.liveUi?.spriteExpressions?.dir).toBe('./live2d-models/ab/expression')
  })
})
