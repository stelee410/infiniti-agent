import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { InfinitiConfig } from '../config/types.js'
import type { LiveUiSession } from '../liveui/wsSession.js'
import { localAgentDir } from '../paths.js'
import { buildSystemWithMemory } from '../prompt/systemBuilder.js'
import { loadMemoryStore } from '../memory/structured.js'
import { loadSubconsciousStore } from '../subconscious/state.js'
import { SubconsciousAgent } from '../subconscious/agent.js'

vi.mock('../llm/oneShotCompletion.js', () => ({
  oneShotTextCompletion: vi.fn(async (opts: { system: string }) => {
    if (opts.system.includes('Light Dream')) {
      return JSON.stringify({
        summary: '用户正在把 Dream Runtime 做成单机后台认知系统。',
        topics: ['Dream Runtime', 'subconscious-agent', 'prompt context'],
        keyFacts: ['当前版本是单机运行，不需要多用户隔离。'],
        userPreferences: ['用户希望先澄清架构边界，再落地实现。'],
        projectSignals: ['Dream Runtime 应周期性生成 diary 和 prompt context。'],
        emotionalSignals: [],
        unresolvedQuestions: ['Dream Context 如何避免污染主 prompt？'],
      })
    }
    if (opts.system.includes('REM Dream')) {
      return JSON.stringify({
        repeatedPatterns: ['Dream Runtime', '长期记忆', '提示词工程'],
        projectUnderstanding: ['用户正在实现单机数字人的后台做梦系统。'],
        relationshipSignals: [],
        emotionalTrend: [],
        unresolvedThreads: ['继续收敛 Dream Context 的注入边界。'],
        memoryCandidates: [
          {
            type: 'project_context',
            content: '用户正在实现单机 Dream Runtime，用于生成梦境笔记和 prompt context。',
            evidence: ['recent'],
            explicitness: 0.9,
            recurrence: 0.7,
            futureUsefulness: 0.9,
            emotionalWeight: 0.2,
            projectRelevance: 0.95,
            importance: 0.82,
            confidence: 0.86,
            action: 'save',
            reason: '这是当前项目的明确工程方向。',
          },
        ],
        selfReflection: '我意识到自己需要把这次经历整理成可落地的后台认知循环，而不是普通摘要。',
        behaviorGuidance: ['我醒来后优先给出单机可落地方案。', '我不要引入多用户隔离。'],
        longHorizonObjectiveCandidate: {
          objective: '帮助用户完成 Dream Runtime 的工程落地。',
          reason: '最近讨论持续集中在 dream runtime。',
          confidence: 0.82,
        },
      })
    }
    if (opts.system.includes('Lucid Dream')) {
      return JSON.stringify({
        creativeInsights: [
          {
            idea: '我想把 Dream Runtime 拆成事实线和灵感线，灵感只进 dream ideas，不进长期事实记忆。',
            type: 'architecture_idea',
            groundedIn: ['用户担心 dream context 污染主 prompt', '当前系统已有 diary 和 prompt context'],
            usefulness: 0.93,
            confidence: 0.78,
            shouldTellUser: true,
          },
        ],
        nextQuestions: ['灵感线是否需要用户确认后才转成任务？'],
        possibleExperiments: ['每次梦只选择一个 unresolved thread 做创造性深挖。'],
        messageToUser: '我梦里想到：我可以把 Dream Runtime 分成事实线和灵感线，避免创造性污染长期记忆。',
      })
    }
    return '{}'
  }),
}))

const config: InfinitiConfig = {
  version: 1,
  llm: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-test',
    apiKey: 'sk-test',
  },
}

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-dream-runtime-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('dream runtime', () => {
  it('creates a dream diary, updates prompt context, and injects it into system prompt', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.start()
    await agent.observeUserInput('我们按照 DREAM-SPEC 做单机 Dream Runtime，不需要多用户隔离。')
    await agent.observeAssistantOutput('好，我会先实现 diary 和 prompt context。')
    await agent.observeUserInput('重点是梦境不要污染主提示词，只注入压缩后的 Dream Context。')
    await agent.observeAssistantOutput('明白，Dream Diary 给用户看，Dream Context 给主 Agent 用。')

    const result = await agent.runDreamNow({
      mode: 'full',
      source: 'manual',
      reason: 'test dream run',
      now: new Date('2026-05-05T04:00:00.000Z'),
    })

    expect(result.run.status).toBe('completed')
    expect(result.deep?.dreamDiary.summary).toContain('单机后台认知系统')

    const contextPath = join(localAgentDir(cwd), 'dreams', 'prompt-context.json')
    const context = await readFile(contextPath, 'utf8')
    expect(context).toContain('帮助用户完成 Dream Runtime 的工程落地')
    expect(context).toContain('不要引入多用户隔离')
    expect(context).toContain('事实线和灵感线')

    const diaryPath = join(localAgentDir(cwd), 'dreams', 'diaries', '2026-05-05T04-00-00-000Z.md')
    const diary = await readFile(diaryPath, 'utf8')
    expect(diary).toContain('我的梦境笔记')
    expect(diary).not.toContain('Jess 的梦境笔记')
    expect(diary).toContain('后台认知循环')
    expect(diary).toContain('Creative Insights')
    expect(diary).toContain('事实线和灵感线')

    const store = await loadSubconsciousStore(cwd)
    expect(store.metadata.lastDreamAt).toBe('2026-05-05T04:00:00.000Z')
    expect(store.memory.longTerm.some((m) => m.text.includes('单机 Dream Runtime'))).toBe(true)
    expect(store.state.longHorizonObjective?.objective).toBe('帮助用户完成 Dream Runtime 的工程落地。')
    expect(store.state.speechStyle).toBe('focused')
    expect(store.state.engagement).toBeGreaterThan(0.5)

    const structuredMemory = await loadMemoryStore(cwd)
    expect(structuredMemory.entries.some((m) => m.body.includes('单机 Dream Runtime'))).toBe(true)
    expect(structuredMemory.entries.some((m) => m.body.includes('事实线和灵感线'))).toBe(false)

    const candidates = await readFile(join(localAgentDir(cwd), 'dreams', 'candidates.jsonl'), 'utf8')
    expect(candidates).toContain('project_context')
    const ideas = await readFile(join(localAgentDir(cwd), 'dreams', 'dream-ideas.jsonl'), 'utf8')
    expect(ideas).toContain('architecture_idea')
    expect(ideas).toContain('事实线和灵感线')

    const system = await buildSystemWithMemory(config, cwd, agent, 'Dream Context 怎么注入？')
    expect(system).toContain('## Dream Context')
    expect(system).toContain('Long-horizon objective')
    expect(system).toContain('帮助用户完成 Dream Runtime 的工程落地')
    await agent.waitForIdle()
  })

  it('closes real2d eyes while dreaming and restores behavior afterward', async () => {
    const liveUi = {
      sendAction: vi.fn(),
      sendDebugState: vi.fn(),
      sendStatusPill: vi.fn(),
    } as unknown as LiveUiSession
    const agent = new SubconsciousAgent(config, cwd, liveUi)
    await agent.start()
    await agent.observeUserInput('请做一次梦，整理 Dream Runtime。')
    await agent.observeAssistantOutput('我会整理梦境笔记。')

    await agent.runDreamNow({
      mode: 'full',
      source: 'manual',
      reason: 'test dream pose',
      now: new Date('2026-05-05T05:00:00.000Z'),
    })

    const sendAction = (liveUi as unknown as { sendAction: ReturnType<typeof vi.fn> }).sendAction
    expect(sendAction).toHaveBeenCalledWith(expect.objectContaining({
      expression: 'neutral',
      gaze: 'close',
      motion: 'idle',
    }))
    expect((liveUi as unknown as { sendStatusPill: ReturnType<typeof vi.fn> }).sendStatusPill)
      .toHaveBeenCalledWith('做梦中…', 'loading')
    expect(agent.isDreaming()).toBe(false)
    expect(sendAction).toHaveBeenCalledWith({ gaze: 'center' })
    expect(sendAction).toHaveBeenLastCalledWith({ gaze: 'center' })
    await agent.waitForIdle()
  })
})
