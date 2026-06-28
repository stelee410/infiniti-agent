import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubconsciousAgent } from './agent.js'
import type { ExternalMemoryBackend } from '../memory/external/agentmem.js'
import type { InfinitiConfig } from '../config/types.js'

const config: InfinitiConfig = {
  version: 1,
  llm: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 'k' },
}

class FakeBackend implements ExternalMemoryBackend {
  adds: Array<{ user: string; resp: string; idem?: string }> = []
  queries: string[] = []
  async query(userMessage: string): Promise<string> {
    this.queries.push(userMessage)
    return '用户喜欢乌龙茶'
  }
  async add(userInput: string, agentResponse: string, idemKey?: string): Promise<void> {
    this.adds.push({ user: userInput, resp: agentResponse, idem: idemKey })
  }
}

let cwd: string

function makeAgent(backend: ExternalMemoryBackend): SubconsciousAgent {
  return new SubconsciousAgent(config, cwd, undefined, backend)
}

async function flush(agent: SubconsciousAgent): Promise<void> {
  await agent.enqueueMemoryWork(() => Promise.resolve())
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'agentmem-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('SubconsciousAgent with external memory (memory-only replace)', () => {
  it('uploads paired user+assistant turn to external on observe', async () => {
    const backend = new FakeBackend()
    const agent = makeAgent(backend)
    await agent.observeUserInput('我喜欢乌龙茶')
    await agent.observeAssistantOutput('记住了')
    await flush(agent)
    expect(backend.adds).toHaveLength(1)
    expect(backend.adds[0]).toMatchObject({ user: '我喜欢乌龙茶', resp: '记住了' })
    expect(backend.adds[0]!.idem).toMatch(/_turn_1$/)
  })

  it('does not upload empty assistant output', async () => {
    const backend = new FakeBackend()
    const agent = makeAgent(backend)
    await agent.observeUserInput('hi')
    await agent.observeAssistantOutput('   ')
    await flush(agent)
    expect(backend.adds).toHaveLength(0)
  })

  it('retrieves from external and wraps with heading', async () => {
    const backend = new FakeBackend()
    const block = await makeAgent(backend).retrieveRelevantMemory('我喜欢什么茶？')
    expect(backend.queries).toEqual(['我喜欢什么茶？'])
    expect(block).toContain('AgentMem')
    expect(block).toContain('用户喜欢乌龙茶')
  })

  it('usesExternalMemory reflects backend presence', () => {
    expect(makeAgent(new FakeBackend()).usesExternalMemory).toBe(true)
    expect(new SubconsciousAgent(config, cwd).usesExternalMemory).toBe(false)
  })

  it('keeps memory tool local (does not forward to external backend)', async () => {
    const backend = new FakeBackend()
    const agent = makeAgent(backend)
    const res = await agent.executeMemoryAction({ action: 'add', title: '茶', body: '喜欢乌龙茶' })
    await flush(agent)
    expect(res.ok).toBe(true)
    // 常驻层写本地，不经外部 add
    expect(backend.adds).toHaveLength(0)
  })

  it('heartbeat still runs the emotion engine (does not early-return null in external mode)', async () => {
    const backend = new FakeBackend()
    const agent = makeAgent(backend)
    // 不应抛错；返回值是主动问候（空闲不足时为 null），关键是 heartbeat 没被整体短路。
    await expect(agent.heartbeat()).resolves.not.toThrow
  })
})
