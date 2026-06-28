import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentMemBackend, createExternalMemoryBackend } from './agentmem.js'
import type { InfinitiConfig } from '../../config/types.js'

const cfg = { baseUrl: 'https://mem.example.com', apiKey: 'mem_test', timeoutMs: 1000 }

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AgentMemBackend.query', () => {
  it('returns injected_context and sends correct request', async () => {
    const fn = mockFetch(async () => jsonResponse({ injected_context: '用户喜欢乌龙茶' }))
    const backend = new AgentMemBackend(cfg)
    const ctx = await backend.query('我喜欢什么茶？')
    expect(ctx).toBe('用户喜欢乌龙茶')
    const [url, init] = fn.mock.calls[0]!
    expect(url).toBe('https://mem.example.com/v1/memory/query')
    expect((init.headers as Record<string, string>)['X-Memory-API-Key']).toBe('mem_test')
    expect(JSON.parse(init.body as string)).toEqual({ query: '我喜欢什么茶？', top_k: 6 })
  })

  it('returns empty string when injected_context missing or non-string', async () => {
    mockFetch(async () => jsonResponse({ foo: 'bar' }))
    expect(await new AgentMemBackend(cfg).query('q')).toBe('')
  })

  it('returns empty string for empty query without calling fetch', async () => {
    const fn = mockFetch(async () => jsonResponse({ injected_context: 'x' }))
    expect(await new AgentMemBackend(cfg).query('   ')).toBe('')
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns empty string on HTTP 401 without throwing', async () => {
    mockFetch(async () => jsonResponse({ error: 'unauthorized' }, 401))
    expect(await new AgentMemBackend(cfg).query('q')).toBe('')
  })

  it('returns empty string on network/timeout error', async () => {
    mockFetch(async () => {
      throw new Error('aborted')
    })
    expect(await new AgentMemBackend(cfg).query('q')).toBe('')
  })
})

describe('AgentMemBackend.add', () => {
  it('posts user_input/agent_response with idempotency header', async () => {
    const fn = mockFetch(async () => jsonResponse({ ok: true }))
    await new AgentMemBackend(cfg).add('我喜欢乌龙茶', '记住了', 'sess_1_turn_1')
    const [url, init] = fn.mock.calls[0]!
    expect(url).toBe('https://mem.example.com/v1/memory/add')
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('sess_1_turn_1')
    expect(JSON.parse(init.body as string)).toEqual({
      user_input: '我喜欢乌龙茶',
      agent_response: '记住了',
    })
  })

  it('skips fetch when both inputs empty', async () => {
    const fn = mockFetch(async () => jsonResponse({}))
    await new AgentMemBackend(cfg).add('  ', '')
    expect(fn).not.toHaveBeenCalled()
  })

  it('does not throw on failure', async () => {
    mockFetch(async () => jsonResponse({ error: 'bad' }, 422))
    await expect(new AgentMemBackend(cfg).add('a', 'b')).resolves.toBeUndefined()
  })
})

describe('createExternalMemoryBackend', () => {
  const base: InfinitiConfig = {
    version: 1,
    llm: { provider: 'openai', baseUrl: 'x', model: 'm', apiKey: 'k' },
  }

  it('returns backend when backend=agentmem and keys present', () => {
    const c = { ...base, memory: { backend: 'agentmem' as const, agentmem: { baseUrl: 'https://x', apiKey: 'mem_y' } } }
    expect(createExternalMemoryBackend(c)).toBeInstanceOf(AgentMemBackend)
  })

  it('returns undefined when backend is local', () => {
    const c = { ...base, memory: { backend: 'local' as const, agentmem: { baseUrl: 'https://x', apiKey: 'mem_y' } } }
    expect(createExternalMemoryBackend(c)).toBeUndefined()
  })

  it('returns undefined when apiKey missing', () => {
    const c = { ...base, memory: { backend: 'agentmem' as const, agentmem: { baseUrl: 'https://x', apiKey: '' } } }
    expect(createExternalMemoryBackend(c)).toBeUndefined()
  })

  it('returns undefined when memory section absent', () => {
    expect(createExternalMemoryBackend(base)).toBeUndefined()
  })
})
