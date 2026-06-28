import type { AgentMemConfig, InfinitiConfig } from '../../config/types.js'
import { isAgentMemEnabled } from '../../config/types.js'
import { agentDebug } from '../../utils/agentDebug.js'

const DEFAULT_TOP_K = 6
const DEFAULT_TIMEOUT_MS = 8000

/**
 * 外部记忆后端抽象。当前唯一实现是 AgentMem V7。
 * 所有方法都「失败即降级」：query 失败返回空上下文，add 失败静默吞掉，绝不抛错或阻塞对话。
 */
export interface ExternalMemoryBackend {
  /** 对话前检索；返回可直接注入 system prompt 的上下文串，失败返回 ''。 */
  query(userMessage: string): Promise<string>
  /** 对话后写入一轮原文；失败静默吞掉。 */
  add(userInput: string, agentResponse: string, idemKey?: string): Promise<void>
}

/**
 * AgentMem V7 数据面客户端。
 * 鉴权头统一 `X-Memory-API-Key: mem_...`；只用到 /v1/memory/query 与 /v1/memory/add。
 * 创建 Memory / 管理 Admin-Key 是平台后端职责，不在本客户端范围内。
 */
export class AgentMemBackend implements ExternalMemoryBackend {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly topK: number
  private readonly timeoutMs: number

  constructor(cfg: AgentMemConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.topK = cfg.topK ?? DEFAULT_TOP_K
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async query(userMessage: string): Promise<string> {
    const q = userMessage.trim()
    if (!q) return ''
    try {
      const res = await this.post('/v1/memory/query', { query: q, top_k: this.topK })
      if (!res) return ''
      const data = (await res.json()) as { injected_context?: unknown }
      return typeof data.injected_context === 'string' ? data.injected_context.trim() : ''
    } catch (e) {
      agentDebug('[agentmem] query failed', e)
      return ''
    }
  }

  async add(userInput: string, agentResponse: string, idemKey?: string): Promise<void> {
    if (!userInput.trim() && !agentResponse.trim()) return
    try {
      await this.post(
        '/v1/memory/add',
        { user_input: userInput, agent_response: agentResponse },
        idemKey ? { 'Idempotency-Key': idemKey } : undefined,
      )
    } catch (e) {
      agentDebug('[agentmem] add failed', e)
    }
  }

  private async post(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'X-Memory-API-Key': this.apiKey,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        agentDebug(`[agentmem] ${path} -> HTTP ${res.status}`)
        return null
      }
      return res
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 工厂：AgentMem 启用且配置齐全时返回 backend，否则 undefined（=用本地记忆）。 */
export function createExternalMemoryBackend(
  config: InfinitiConfig,
): ExternalMemoryBackend | undefined {
  if (!isAgentMemEnabled(config)) return undefined
  return new AgentMemBackend(config.memory!.agentmem!)
}
