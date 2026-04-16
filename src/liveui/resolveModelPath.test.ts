import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  resolveLive2dModelForUi,
  resolveModelDictUrlToFilesystem,
  resolveSpriteExpressionDirForUi,
} from './resolveModelPath.js'

describe('resolveModelDictUrlToFilesystem', () => {
  it('maps /live2d-models/... to live2dModelsDir root', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'infiniti-map-'))
    mkdirSync(join(cwd, 'live2d-models'), { recursive: true })
    try {
      const p = resolveModelDictUrlToFilesystem(
        cwd,
        './live2d-models',
        '/live2d-models/mao/runtime/mao.model3.json',
      )
      expect(p).toBe(join(cwd, 'live2d-models', 'mao', 'runtime', 'mao.model3.json'))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('joins url under cwd when modelsDir omitted', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'infiniti-url-'))
    try {
      const p = resolveModelDictUrlToFilesystem(cwd, undefined, '/live2d-models/x/m.model3.json')
      expect(p).toBe(join(cwd, 'live2d-models', 'x', 'm.model3.json'))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('resolveLive2dModelForUi', () => {
  it('resolves live2dModel3Json', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'infiniti-l2d-'))
    const model = join(cwd, 'a.model3.json')
    writeFileSync(model, '{}')
    try {
      const r = resolveLive2dModelForUi(cwd, { live2dModel3Json: './a.model3.json' })
      expect(r?.model3JsonPath).toBe(model)
      expect(r?.model3FileUrl.startsWith('file:')).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('resolves model_dict + name + live2dModelsDir', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'infiniti-l2d-'))
    const root = join(cwd, 'live2d-models')
    const modelDir = join(root, 'mao', 'runtime')
    mkdirSync(modelDir, { recursive: true })
    const model = join(modelDir, 'mao.model3.json')
    writeFileSync(model, '{}')

    const dictPath = join(cwd, 'model_dict.json')
    writeFileSync(
      dictPath,
      JSON.stringify([{ name: 'mao', url: '/live2d-models/mao/runtime/mao.model3.json' }]),
    )

    try {
      const r = resolveLive2dModelForUi(cwd, {
        live2dModelsDir: './live2d-models',
        live2dModelDict: './model_dict.json',
        live2dModelName: 'mao',
      })
      expect(r?.model3JsonPath).toBe(model)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('resolveSpriteExpressionDirForUi', () => {
  it('returns file URL for existing directory', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'infiniti-spr-'))
    const dir = join(cwd, 'expr')
    mkdirSync(dir, { recursive: true })
    try {
      const r = resolveSpriteExpressionDirForUi(cwd, { spriteExpressions: { dir: './expr' } })
      expect(r?.dirFileUrl.startsWith('file:')).toBe(true)
      expect(r?.dirFileUrl.endsWith('/')).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns null when dir missing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'infiniti-spr2-'))
    try {
      expect(resolveSpriteExpressionDirForUi(cwd, { spriteExpressions: { dir: './nope' } })).toBeNull()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
