import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isAllowedLiveUiMediaPath } from './wsSession.js'
import { LiveUiSession } from './wsSession.js'

describe('isAllowedLiveUiMediaPath', () => {
  it('allows files under configured media roots', () => {
    const root = resolve('/tmp/infiniti-agent/.infiniti-agent')
    expect(isAllowedLiveUiMediaPath(join(root, 'inbox/assets/video.mp4'), [root])).toBe(true)
  })

  it('rejects absolute paths outside configured media roots', () => {
    const root = resolve('/tmp/infiniti-agent/.infiniti-agent')
    expect(isAllowedLiveUiMediaPath('/etc/passwd', [root])).toBe(false)
  })

  it('writes a temp WAV file and emits filePath for non-stream engines', async () => {
    const messages: { type: string; data?: Record<string, unknown> }[] = []
    const session = new LiveUiSession(0, { assistantVoicePossible: 1, random: () => 0 })
    session.broadcast = (msg: { type: string; data?: Record<string, unknown> }) => {
      messages.push(msg)
    }
    session.setTtsEngine({
      async synthesize() {
        return {
          data: Buffer.from('wav bytes'),
          format: 'wav',
          sampleRate: 24000,
        }
      },
    })

    session.beginAssistantTurn()
    await session.finalizeAssistantVoice('hello')

    expect(messages).toContainEqual({ type: 'ASSISTANT_VOICE', data: { status: 'started' } })
    const completed = messages.find((m) => m.type === 'ASSISTANT_VOICE' && m.data?.status === 'completed')
    expect(completed?.data).toMatchObject({ status: 'completed', format: 'wav', sampleRate: 24000 })
    expect(completed?.data?.audioBase64).toBeUndefined()
    expect(typeof completed?.data?.filePath).toBe('string')
    const filePath = completed?.data?.filePath as string
    expect(filePath.endsWith('reply.wav')).toBe(true)
    expect(await readFile(filePath)).toEqual(Buffer.from('wav bytes'))
  })

  it('aborts a stream after 2s of idle and writes a WAV from collected PCM', async () => {
    const messages: { type: string; data?: Record<string, unknown> }[] = []
    const session = new LiveUiSession(0, { assistantVoicePossible: 1, random: () => 0 })
    session.broadcast = (msg: { type: string; data?: Record<string, unknown> }) => {
      messages.push(msg)
    }
    let abortedSeen = false
    session.setTtsEngine({
      async synthesize() {
        throw new Error('not used')
      },
      async synthesizeStream(_text, emit, signal) {
        await emit({
          data: Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]),
          format: 'pcm_s16le',
          sampleRate: 16000,
          channels: 1,
        })
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            abortedSeen = true
            resolve()
            return
          }
          signal?.addEventListener('abort', () => {
            abortedSeen = true
            resolve()
          }, { once: true })
        })
      },
    })

    session.beginAssistantTurn()
    const t0 = Date.now()
    await session.finalizeAssistantVoice('hi there')
    const elapsed = Date.now() - t0

    expect(abortedSeen).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(1800)
    expect(elapsed).toBeLessThan(4000)
    const completed = messages.find((m) => m.type === 'ASSISTANT_VOICE' && m.data?.status === 'completed')
    expect(completed?.data).toMatchObject({ status: 'completed', format: 'wav', sampleRate: 16000 })
    const filePath = completed?.data?.filePath as string
    const out = await readFile(filePath)
    expect(out.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(out.length).toBe(44 + 8)
  }, 10_000)

  it('emits failed when no audio is produced', async () => {
    const messages: { type: string; data?: Record<string, unknown> }[] = []
    const session = new LiveUiSession(0, { assistantVoicePossible: 1, random: () => 0 })
    session.broadcast = (msg: { type: string; data?: Record<string, unknown> }) => {
      messages.push(msg)
    }
    session.setTtsEngine({
      async synthesize() {
        return { data: Buffer.alloc(0), format: 'wav', sampleRate: 24000 }
      },
    })

    session.beginAssistantTurn()
    await session.finalizeAssistantVoice('quiet')

    const failed = messages.find((m) => m.type === 'ASSISTANT_VOICE' && m.data?.status === 'failed')
    expect(failed?.data?.status).toBe('failed')
  })

  it('sendAssistantMedia broadcasts ASSISTANT_MEDIA and resolves on ASSISTANT_MEDIA_RESULT ack', async () => {
    const session = new LiveUiSession(0)
    let pushedRequestId: string | undefined
    session.broadcast = (msg: unknown) => {
      const m = msg as { type?: string; data?: Record<string, unknown> }
      if (m.type === 'ASSISTANT_MEDIA') {
        pushedRequestId = m.data?.requestId as string
      }
    }
    // Pretend a client is connected so sendAssistantMedia doesn't short-circuit.
    ;(session as unknown as { clients: Set<unknown> }).clients = new Set([{}])

    const promise = session.sendAssistantMedia({ filePath: '/tmp/x.png', kind: 'image', caption: '看' })
    await new Promise((r) => setTimeout(r, 0))
    expect(typeof pushedRequestId).toBe('string')
    ;(session as unknown as {
      handleAssistantMediaResult(id: string, ok: boolean, error?: string): void
    }).handleAssistantMediaResult(pushedRequestId!, true)
    const result = await promise
    expect(result).toEqual({ ok: true, requestId: pushedRequestId })
  })

  it('sendAssistantMedia returns no-client error when no live client connected', async () => {
    const session = new LiveUiSession(0)
    const result = await session.sendAssistantMedia({ filePath: '/tmp/x.png', kind: 'image' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no live client connected')
  })
})
