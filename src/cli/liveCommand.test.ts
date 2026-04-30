import { describe, expect, it, vi } from 'vitest'
import type { InfinitiConfig } from '../config/types.js'
import {
  LiveCommandError,
  parseLivePort,
  parseLiveZoomOverride,
  resolveLiveCommandPlan,
  type LiveCommandDeps,
} from './liveCommand.js'

function cfg(liveUi: InfinitiConfig['liveUi'] = {}): InfinitiConfig {
  return {
    version: 1,
    llm: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1',
      apiKey: 'k',
    },
    liveUi,
  }
}

function deps(overrides: Partial<LiveCommandDeps> = {}): LiveCommandDeps {
  return {
    envPort: undefined,
    resolveSpriteExpressionDirForUi: vi.fn(() => null),
    resolveLive2dModelForUi: vi.fn(() => ({
      model3JsonPath: '/model.json',
      model3FileUrl: 'file:///model.json',
      warnings: [],
    })),
    buildLiveUiVoiceMicEnvJson: vi.fn(() => '{"mode":"push_to_talk"}'),
    ...overrides,
  }
}

describe('liveCommand', () => {
  it('resolves port priority from explicit, config, env, then default', () => {
    expect(parseLivePort('9001', 9002, '9003')).toBe(9001)
    expect(parseLivePort(undefined, 9002, '9003')).toBe(9002)
    expect(parseLivePort(undefined, undefined, '9003')).toBe(9003)
    expect(parseLivePort(undefined, undefined, undefined)).toBe(8080)
    expect(() => parseLivePort('70000', undefined, undefined)).toThrow(LiveCommandError)
  })

  it('parses optional zoom override with range validation', () => {
    expect(parseLiveZoomOverride('0.8')).toBe(0.8)
    expect(parseLiveZoomOverride(undefined)).toBeUndefined()
    expect(() => parseLiveZoomOverride('0.1')).toThrow(LiveCommandError)
  })

  it('uses sprite renderer when sprite expressions are available', () => {
    const d = deps({
      resolveSpriteExpressionDirForUi: vi.fn(() => ({
        dirFileUrl: 'file:///sprites/',
        warnings: [],
      })),
    })

    const plan = resolveLiveCommandPlan('/project', cfg(), {}, d)

    expect(plan.renderer).toBe('sprite')
    expect(plan.spriteExpressionDirFileUrl).toBe('file:///sprites/')
    expect(plan.model3FileUrl).toBeUndefined()
    expect(plan.info).toContain('已启用 spriteExpressions（PNG），不使用 Live2D 模型 URL')
  })

  it('falls back to live2d and warns when real2d is configured without sprites', () => {
    const plan = resolveLiveCommandPlan(
      '/project',
      cfg({ renderer: 'real2d' }),
      { zoom: '1.2', auto: true },
      deps(),
    )

    expect(plan.renderer).toBe('live2d')
    expect(plan.model3FileUrl).toBe('file:///model.json')
    expect(plan.figureZoomOverride).toBe(1.2)
    expect(plan.warnings).toContain('renderer=real2d 需要 liveUi.spriteExpressions.dir，当前将回退 Live2D/占位')
    expect(plan.info).toContain('人物缩放: 120%')
  })
})
