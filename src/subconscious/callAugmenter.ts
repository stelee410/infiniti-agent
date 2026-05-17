import type { InfinitiConfig } from '../config/types.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import { agentDebug } from '../utils/agentDebug.js'
import type { SubconsciousAgent } from './agent.js'

const AUGMENTER_TIMEOUT_MS = 25_000
const MEMORY_TAGS = ['fact', 'preference', 'lesson', 'convention', 'environment', 'other'] as const
type MemoryTag = typeof MEMORY_TAGS[number]

/**
 * 通话模式后台 agent：**不产生新的回复文本**，专注三件事——
 *   1. intent：用一句话理解用户这一轮在说什么 / 想达成什么；
 *   2. memorize：判断是否值得长期记忆（事实、偏好、承诺、教训…），命中则写
 *      入 structured memory，下次对话可被检索到；
 *   3. recall：判断是否需要从长期记忆里捞背景；命中则查询，结果拼成片段，
 *      下一轮 system prompt 注入；
 *   4. toolPlan：判断是否需要调用工具（如查时间、查网络）；目前只**计划不
 *      执行**——执行会在下一阶段加白名单工具调度，避免在通话场景里阻塞或
 *      产生副作用。
 *
 * 整个过程异步，不阻塞主对话流。
 */

const AUGMENTER_SYSTEM = `你是「电话通话」模式的后台分析 agent。主对话 LLM 刚和用户完成了一轮口语对话——它没有工具能力，回复必然是浅层、口语化的。

你的任务**不是再回复一遍**，而是分析这一轮，输出一个结构化判断 JSON：

{
  "intent": string,                        // 一句话概括用户本轮意图（中文，不超过 40 字）。
  "memorize": null | {                     // 是否值得写进长期记忆。
    "title": string,                       // 简短标题（不超过 24 字）。
    "body": string,                        // 主体（80~300 字，事实/承诺/偏好/事件细节，用陈述句）。
    "tag": "fact"|"preference"|"lesson"|"convention"|"environment"|"other"
  },
  "recall": null | {                       // 是否需要从已有长期记忆里捞背景给下一轮用。
    "queries": string[]                    // 1~3 条中文检索关键词（不是问句）。
  },
  "toolPlan": null | {                     // 是否需要调用工具（暂仅记录意图，下一阶段执行）。
    "tool": string,                        // 工具名（http_request/read_file/grep_files/...）。
    "purpose": string                      // 为什么需要这个工具，30 字内。
  }
}

判定标准：
- memorize 命中条件（满足任一即可）：
  - 用户透露了**他自己**的偏好/习惯/计划/承诺；
  - 用户讲述了重要事件（健康、家人、工作变动、出行）；
  - 用户给你下达了**约定**（"以后都这样"、"记住"）；
  - 你这一轮主动**承诺**了某事（"我下次会..."）；
- 否则 memorize=null。**不要**把寒暄、客套、情绪话写进 memory。
- recall 命中条件：用户问到了"我之前说过...""你记得吗"之类，或讨论延续性话题需要历史背景。
- toolPlan：仅在用户问到了**精确**的、需要外部信息才能答的问题（时间、天气、网址内容、本地文件）时才填，否则 null。
- 三个判断**互相独立**，可以全部 null。
- 整段输出**严格 JSON 单行**，不要 markdown、不要注释、不要前后多余文字。`

function isMemoryTag(s: unknown): s is MemoryTag {
  return typeof s === 'string' && (MEMORY_TAGS as readonly string[]).includes(s)
}

type AugmenterJudgment = {
  intent: string
  memorize: { title: string; body: string; tag: MemoryTag } | null
  recall: { queries: string[] } | null
  toolPlan: { tool: string; purpose: string } | null
}

function tryParseJson(raw: string): AugmenterJudgment | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>
    const intent = typeof obj.intent === 'string' ? obj.intent.trim().slice(0, 120) : ''
    const memorize = (() => {
      const v = obj.memorize as Record<string, unknown> | null | undefined
      if (!v || typeof v !== 'object') return null
      const title = typeof v.title === 'string' ? v.title.trim() : ''
      const body = typeof v.body === 'string' ? v.body.trim() : ''
      const tag: MemoryTag = isMemoryTag(v.tag) ? v.tag : 'other'
      if (!title || !body) return null
      return { title: title.slice(0, 60), body: body.slice(0, 600), tag }
    })()
    const recall = (() => {
      const v = obj.recall as Record<string, unknown> | null | undefined
      if (!v || typeof v !== 'object') return null
      const qs = Array.isArray(v.queries)
        ? v.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, 3)
        : []
      return qs.length ? { queries: qs } : null
    })()
    const toolPlan = (() => {
      const v = obj.toolPlan as Record<string, unknown> | null | undefined
      if (!v || typeof v !== 'object') return null
      const tool = typeof v.tool === 'string' ? v.tool.trim() : ''
      const purpose = typeof v.purpose === 'string' ? v.purpose.trim() : ''
      if (!tool) return null
      return { tool: tool.slice(0, 60), purpose: purpose.slice(0, 100) }
    })()
    return { intent, memorize, recall, toolPlan }
  } catch {
    return null
  }
}

export type CallAugmenterOptions = {
  config: InfinitiConfig
  subconscious?: SubconsciousAgent
  signal?: AbortSignal
  /** LLM profile 名；不传则按 config.llm.callAugmenterProfile → subconsciousProfile → default 顺序 fallback。 */
  profile?: string
}

export type CallAugmenterResult = {
  intent: string
  memorized: boolean
  recallSnippet: string | null
  toolPlanned: string | null
}

export class CallAugmenter {
  private inFlight: AbortController | null = null

  constructor(private readonly opts: CallAugmenterOptions) {}

  cancel(): void {
    if (this.inFlight) {
      this.inFlight.abort()
      this.inFlight = null
    }
  }

  /**
   * 异步评估一轮对话：理解意图、决定记不记、决定要不要捞历史、记录工具计划。
   * 返回 recallSnippet 字符串（如有）供下一轮主对话 system prompt 注入；
   * memorize / toolPlan 是侧效果（写 memory / 写 console），不进 prompt。
   *
   * 任一步骤失败都不抛错，返回 null/默认值。
   */
  async augment(userText: string, assistantText: string): Promise<CallAugmenterResult | null> {
    this.cancel()
    const controller = new AbortController()
    this.inFlight = controller
    const onParentAbort = () => controller.abort()
    if (this.opts.signal) {
      if (this.opts.signal.aborted) return null
      this.opts.signal.addEventListener('abort', onParentAbort, { once: true })
    }
    try {
      const profile = this.opts.profile
        ?? this.opts.config.llm.callAugmenterProfile
        ?? this.opts.config.llm.subconsciousProfile

      const judgmentRaw = await Promise.race([
        oneShotTextCompletion({
          config: this.opts.config,
          system: AUGMENTER_SYSTEM,
          user: `用户：${userText}\n助手：${assistantText}\n请输出 JSON。`,
          maxOutTokens: 512,
          ...(profile ? { profile } : {}),
        }),
        new Promise<string>((_resolve, reject) => {
          const t = setTimeout(() => reject(new Error('augmenter timeout')), AUGMENTER_TIMEOUT_MS)
          controller.signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('augmenter aborted'))
          })
        }),
      ]).catch((e) => {
        agentDebug('[callAugmenter] LLM judgment failed', (e as Error).message)
        return null
      })
      if (controller.signal.aborted) return null
      if (typeof judgmentRaw !== 'string') return null
      const j = tryParseJson(judgmentRaw)
      if (!j) {
        agentDebug('[callAugmenter] JSON parse failed', judgmentRaw.slice(0, 200))
        return null
      }
      agentDebug('[callAugmenter] intent', j.intent, '| memorize', !!j.memorize, '| recall', !!j.recall, '| tool', j.toolPlan?.tool ?? '-')

      // memorize：直接写入结构化 memory
      let memorized = false
      if (j.memorize && this.opts.subconscious) {
        try {
          const res = await this.opts.subconscious.executeMemoryAction({
            action: 'add',
            title: j.memorize.title,
            body: j.memorize.body,
            tag: j.memorize.tag,
          })
          memorized = !!res.ok
        } catch (e) {
          agentDebug('[callAugmenter] memorize failed', (e as Error).message)
        }
      }

      // recall：拼接为下一轮 system prompt 片段
      let recallSnippet: string | null = null
      if (j.recall && this.opts.subconscious) {
        const parts: string[] = []
        for (const q of j.recall.queries) {
          if (controller.signal.aborted) return null
          try {
            const snippet = await this.opts.subconscious.retrieveRelevantMemory(q)
            if (snippet?.trim()) parts.push(`关于「${q}」：${snippet.trim()}`)
          } catch (e) {
            agentDebug('[callAugmenter] recall failed', q, (e as Error).message)
          }
        }
        if (parts.length) recallSnippet = parts.join('\n')
      }

      // toolPlan：暂只记录，不执行（后续阶段加白名单工具执行）
      const toolPlanned = j.toolPlan ? `${j.toolPlan.tool}（${j.toolPlan.purpose}）` : null
      if (toolPlanned) agentDebug('[callAugmenter] tool plan deferred', toolPlanned)

      return {
        intent: j.intent,
        memorized,
        recallSnippet,
        toolPlanned,
      }
    } finally {
      if (this.opts.signal) {
        this.opts.signal.removeEventListener('abort', onParentAbort)
      }
      if (this.inFlight === controller) {
        this.inFlight = null
      }
    }
  }
}
