import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './io.js'

let cwd: string

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await mkdir(join(cwd, '.infiniti-agent'), { recursive: true })
  await writeFile(
    join(cwd, '.infiniti-agent', 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  )
}

function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    llm: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1',
      apiKey: 'test-key',
    },
    ...extra,
  }
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-config-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('loadConfig field parsing', () => {
  it('trims image profile fields and ignores invalid enum/number values', async () => {
    await writeConfig(baseConfig({
      image: {
        default: ' main ',
        profiles: {
          main: {
            provider: 'gpt-image-2',
            baseUrl: ' https://images.example/v1 ',
            apiKey: ' image-key ',
            model: ' image-model ',
            aspectRatio: ' 1:1 ',
            quality: 'high',
            inputFidelity: 'bogus',
            timeoutMs: 4999,
          },
          bad: {
            provider: 'unknown',
            baseUrl: 'https://bad.example',
            model: 'bad',
          },
        },
      },
    }))

    const cfg = await loadConfig(cwd)
    expect(cfg.image?.default).toBe('main')
    expect(cfg.image?.profiles?.main).toMatchObject({
      provider: 'gpt-image-2',
      baseUrl: 'https://images.example/v1',
      apiKey: 'image-key',
      model: 'image-model',
      aspectRatio: '1:1',
      quality: 'high',
    })
    expect(cfg.image?.profiles?.main?.inputFidelity).toBeUndefined()
    expect(cfg.image?.profiles?.main?.timeoutMs).toBeUndefined()
    expect(cfg.image?.profiles?.bad).toBeUndefined()
  })

  it('keeps valid seedance arrays and drops blank/non-string entries', async () => {
    await writeConfig(baseConfig({
      seedance: {
        provider: 'volcengine',
        baseUrl: ' https://seedance.example ',
        apiKey: ' key ',
        model: ' model ',
        duration: 4.9,
        generateAudio: false,
        watermark: true,
        referenceImageUrls: [' https://a.example/1.png ', '', 42, 'https://a.example/2.png'],
        pollIntervalMs: 999,
        timeoutMs: 10000.9,
      },
    }))

    const cfg = await loadConfig(cwd)
    expect(cfg.seedance).toMatchObject({
      provider: 'volcengine',
      baseUrl: 'https://seedance.example',
      apiKey: 'key',
      model: 'model',
      duration: 4,
      generateAudio: false,
      watermark: true,
      referenceImageUrls: ['https://a.example/1.png', 'https://a.example/2.png'],
      timeoutMs: 10000,
    })
    expect(cfg.seedance?.pollIntervalMs).toBeUndefined()
  })

  it('parses bounded live UI numbers and nested sprite expression paths', async () => {
    await writeConfig(baseConfig({
      liveUi: {
        port: 70000,
        subconsciousHeartbeatMs: 5100.6,
        figureZoom: 1.25,
        renderer: 'real2d',
        ttsAutoEnabled: false,
        asrMode: 'auto',
        voiceMicSpeechRmsThreshold: 0.2,
        voiceMicSilenceEndMs: 500.4,
        spriteExpressions: {
          dir: ' sprites ',
          manifest: ' manifest.json ',
        },
      },
    }))

    const cfg = await loadConfig(cwd)
    expect(cfg.liveUi).toMatchObject({
      subconsciousHeartbeatMs: 5101,
      figureZoom: 1.25,
      renderer: 'real2d',
      ttsAutoEnabled: false,
      asrMode: 'auto',
      voiceMicSpeechRmsThreshold: 0.2,
      voiceMicSilenceEndMs: 500,
      spriteExpressions: {
        dir: 'sprites',
        manifest: 'manifest.json',
      },
    })
    expect(cfg.liveUi?.port).toBeUndefined()
  })
})
