# 外部记忆接入（AgentMem V7）实现文档

> 目标：让 agent 把「记忆」整体托管给外部 [AgentMem V7](https://agentmem.oyii.ai) 服务。
> 用户在配置里填一把 **Memory-Key (`mem_...`)**，agent 每轮对话后把原文上送服务端，
> 下一轮对话前从服务端检索 `injected_context` 注入 system prompt。

本文是实现说明书，按节落地即可。**当前仓库尚未实现**，本文不描述既有代码行为，只描述要新增/修改的内容。

---

## 0. 决策摘要（已确认）

| 决策 | 选择 | 含义 |
|------|------|------|
| 与本地记忆的关系 | **替换情景/长期记忆** | `backend=agentmem` 时，按 query 的情景/长期记忆检索与写入走外部，本地 documentMemory 自动巩固停用；但 structured/profile/kg 常驻层与情绪引擎、dream 保留在本地（见 §4.6）|
| 写入触发 | **每轮对话原文上送** | 每轮 `user_input + agent_response` 直接发给 `/v1/memory/add`，由服务端自行抽取；不依赖本地提炼 |
| CLI 范围 | 只做**数据面** | agent 运行时只需 Memory-Key；创建 Memory / 管理 Admin-Key 是平台后端职责，**不进 CLI**（见 §8 可选扩展） |

---

## 1. AgentMem V7 数据面协议（实现所依据的事实）

agent 运行时只用到两个数据面端点，鉴权头统一为 `X-Memory-API-Key: mem_...`。

### 1.1 对话前检索

```
POST {baseUrl}/v1/memory/query
Header: X-Memory-API-Key: mem_...
Header: Content-Type: application/json
Body:   { "query": "我喜欢什么茶？", "top_k": 6 }
```

返回体含 `injected_context` 字段：**已经是可直接拼进 System Prompt 的上下文串**（是数据不是指令）。失败时按 SDK 语义返回空上下文，不抛错。

### 1.2 对话后写入

```
POST {baseUrl}/v1/memory/add
Header: X-Memory-API-Key: mem_...
Header: Idempotency-Key: session_001_turn_001   （可选，防重复写入）
Header: Content-Type: application/json
Body:   { "user_input": "我喜欢乌龙茶", "agent_response": "好的，下次优先推荐乌龙茶。" }
```

请求体只需对话内容，**不传 `agent_code` / `user_id`**——Memory-Key 自身即记忆容器身份。失败返回 `None` 语义，不阻塞对话主链路。

### 1.3 错误码

| HTTP | 含义 | agent 侧处理 |
|------|------|------|
| 401 | Key 缺失/已删除/已吊销/过期 | 降级为空上下文；debug 日志提示 Key 失效 |
| 403 | Key 类型不对（误用 Admin-Key） | 同上，日志提示用错 Key |
| 422 | 请求体字段不合法 | 日志，丢弃本次写入 |
| 429 | QPS / 配额超限 | 降级，下一轮重试 |

> 实现一律「失败即降级」，任何非 2xx 都不向上抛、不阻塞对话。

---

## 2. 配置 Schema

### 2.1 类型（`src/config/types.ts`）

在文件末尾新增：

```ts
/** 外部记忆后端（AgentMem V7）。配置后 agent 的记忆整体托管给外部服务（Replace 语义）。 */
export type AgentMemConfig = {
  /** 服务根 URL，无尾斜杠，如 https://agentmem.oyii.ai */
  baseUrl: string
  /** Memory-Key（mem_ 前缀）；一把 Key 对应一个终端用户的记忆中枢。 */
  apiKey: string
  /** 检索条数，对应 /v1/memory/query 的 top_k；默认 6。 */
  topK?: number
  /** 单次请求超时（毫秒），超时即降级；默认 8000。 */
  timeoutMs?: number
}

export type MemoryConfig = {
  /**
   * 'local'（默认）：沿用本地 documentMemory + 潜意识记忆。
   * 'agentmem'：Replace 模式，检索/写入全部走外部，本地提炼链路短路。
   */
  backend?: 'local' | 'agentmem'
  agentmem?: AgentMemConfig
}
```

在 `InfinitiConfig` 里追加一行（与 `seedance?` 同级）：

```ts
  seedance?: SeedanceVideoConfig
  memory?: MemoryConfig   // ← 新增
}
```

### 2.2 解析（`src/config/io.ts`）

仿照 `parseSeedanceVideoConfig` 新增一个 `parseMemoryConfig`：

```ts
function parseMemoryConfig(raw: unknown): MemoryConfig | undefined {
  const u = recordField(raw)
  if (!u) return undefined
  const out: MemoryConfig = {}
  const backend = enumField(u.backend, ['local', 'agentmem'] as const)
  if (backend) out.backend = backend

  const am = recordField(u.agentmem)
  if (am) {
    const agentmem: Partial<AgentMemConfig> = {}
    const baseUrl = stringField({ value: am.baseUrl })
    const apiKey = stringField({ value: am.apiKey })
    if (baseUrl) agentmem.baseUrl = baseUrl.replace(/\/+$/, '')   // 去尾斜杠
    if (apiKey) agentmem.apiKey = apiKey
    const topK = numberField({ value: am.topK, min: 1, max: 50, integer: true })
    const timeoutMs = numberField({ value: am.timeoutMs, min: 1000, integer: true })
    if (topK !== undefined) agentmem.topK = topK
    if (timeoutMs !== undefined) agentmem.timeoutMs = timeoutMs
    // baseUrl + apiKey 都齐才算有效
    if (agentmem.baseUrl && agentmem.apiKey) out.agentmem = agentmem as AgentMemConfig
  }
  return Object.keys(out).length ? out : undefined
}
```

接线（与现有 `seedance` 两处对齐）：

- 解析段（约 `io.ts:155`）：
  ```ts
  const memory = parseMemoryConfig(o.memory)
  ```
- 写回对象（约 `io.ts:193`）：
  ```ts
  ...(memory ? { memory } : {}),
  ```
- merge/保留 existing 段（约 `io.ts:607`）：
  ```ts
  ...(existing?.memory ? { memory: existing.memory } : {}),
  ```

> 记得 `import type { MemoryConfig, AgentMemConfig } from './types.js'`（若 io.ts 用集中 import）。

### 2.3 有效性判定 helper（建议放 `config/types.ts` 或新 backend 模块）

```ts
export function isAgentMemEnabled(config: InfinitiConfig): boolean {
  return config.memory?.backend === 'agentmem'
    && !!config.memory.agentmem?.baseUrl
    && !!config.memory.agentmem?.apiKey
}
```

---

## 3. 外部记忆客户端

新建目录 `src/memory/external/`，文件 `agentmem.ts`。

```ts
import type { AgentMemConfig } from '../../config/types.js'
import { agentDebug } from '../../utils/agentDebug.js'

const DEFAULT_TOP_K = 6
const DEFAULT_TIMEOUT_MS = 8000

export interface ExternalMemoryBackend {
  /** 检索；返回可直接注入 system prompt 的上下文串，失败返回 ''。 */
  query(userMessage: string): Promise<string>
  /** 写入一轮对话；失败静默吞掉，绝不抛错。 */
  add(userInput: string, agentResponse: string, idemKey?: string): Promise<void>
}

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
      const ctx = typeof data.injected_context === 'string' ? data.injected_context.trim() : ''
      return ctx
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

/** 工厂：配置有效时返回 backend，否则 undefined（=用本地记忆）。 */
export function createExternalMemoryBackend(
  config: { memory?: { backend?: string; agentmem?: AgentMemConfig } },
): ExternalMemoryBackend | undefined {
  const m = config.memory
  if (m?.backend !== 'agentmem' || !m.agentmem?.baseUrl || !m.agentmem?.apiKey) return undefined
  return new AgentMemBackend(m.agentmem)
}
```

> Node ≥ 20（package.json engines），`fetch` / `AbortController` 为全局，无需额外依赖。

---

## 4. 接入 coordinator（`src/subconscious/agent.ts`）

`SubconsciousAgent` 已经是全局注入的 memory coordinator（实现 `retrieveRelevantMemory` / `observeUserInput` / `observeAssistantOutput`）。把外部 backend 注入它即可，**不改主对话循环、不改 `memory/read.ts` 的注入点**（`read.ts:38` 仍调用 `memoryCoordinator.retrieveRelevantMemory(query)`）。

### 4.1 构造函数

```ts
import type { ExternalMemoryBackend } from '../memory/external/agentmem.js'

export class SubconsciousAgent {
  private lastUserInput = ''           // ← 暂存，用于配对每轮 add
  // ...existing fields...

  constructor(
    readonly config: InfinitiConfig,
    readonly cwd: string,
    private readonly liveUi?: LiveUiSession | null,
    private readonly externalMemory?: ExternalMemoryBackend,   // ← 新增可选参数
  ) {}
```

### 4.2 检索：`retrieveRelevantMemory`

```ts
async retrieveRelevantMemory(query: string): Promise<string> {
  if (this.externalMemory) {
    const ctx = await this.externalMemory.query(query)
    if (!ctx) return ''
    return `## 相关长期记忆（来自 AgentMem）\n${ctx}`
  }
  return memory.retrieveRelevantMemory(this, query)   // 原本地路径
}
```

### 4.3 写入：`observeUserInput` / `observeAssistantOutput`

Replace 模式下短路本地提炼。注意 `observeUserInput` 总在 `observeAssistantOutput` 之前调用，用 `lastUserInput` 配对：

```ts
async observeUserInput(input: string): Promise<void> {
  if (this.externalMemory) {
    this.lastUserInput = input
    this.idleHeartbeatCount = 0
    return                       // 不写本地 subconscious store，不跑 analyzeInput
  }
  return memory.observeUserInput(this, input)
}

async observeAssistantOutput(output: string): Promise<void> {
  if (this.externalMemory) {
    if (!output.trim()) return
    const user = this.lastUserInput
    this.lastUserInput = ''
    const idemKey = this.makeIdempotencyKey()   // 见 §4.4
    void this.enqueueMemoryWork(() => this.externalMemory!.add(user, output, idemKey))
      .catch((e) => agentDebug('[agentmem] add enqueue failed', e))
    return                       // 短路 refineWithLlm / consolidate / dream
  }
  return memory.observeAssistantOutput(this, output)
}
```

> `enqueueMemoryWork` 是既有的异步串行队列，复用它保证写入有序且不阻塞对话。

### 4.4 Idempotency-Key

用「会话标识 + 自增轮次」生成稳定键，防止重试/重放重复写入：

```ts
private turnCounter = 0
private makeIdempotencyKey(): string {
  this.turnCounter += 1
  // sessionId 可取 cwd 的短 hash 或已有 session id；turnCounter 单调递增
  return `${this.sessionTag()}_turn_${this.turnCounter}`
}
```

> 若已有稳定的 session id（如 `.infiniti-agent/session.json` 的 id），优先用它当前缀；否则用 cwd 的短 hash。**不要用时间戳**（重放会变 key，失去幂等意义）。

### 4.5 其它短路点（Replace 模式）

为省 token，`backend` 存在时下列也应跳过（保持 no-op 或早返回）：

- `consolidateFromMessages` / `consolidateRecentMemory`
- `heartbeat` 里的 `scanHistoryForStableFacts` / `runDream`
- `refineWithLlm`

最小实现可只在上面两个 observe 方法里短路；进一步优化时在 `heartbeat` / `consolidateFromMessages` 开头加 `if (this.externalMemory) return`。

### 4.6 替换边界（只替换情景/长期记忆，保留情绪引擎与常驻层）

经实测，把本地记忆**全部**停掉会误伤两类与「情景记忆」无关的能力：① 情绪/心理引擎（render 表情、主动打招呼、关系状态）；② 常驻偏好（structured `preference`/`convention`、用户画像本是**每轮全量注入**，换成按 query 召回后，全局偏好在不相关轮次会漏注入）。因此最终边界是**只替换情景/长期记忆**：

**AgentMem 接管（外部）：**
- 按 query 的情景/长期记忆检索 → `agent.retrieveRelevantMemory()` 走 `externalMemory.query()`（替换本地 documentMemory FTS 召回）。
- 每轮对话原文上送 → `observeAssistantOutput` 配对 `externalMemory.add(user, assistant)`。
- 本地 documentMemory（longTerm/fuzzy）的**自动巩固**停用：`heartbeat` 与 `consolidateFromMessages` 用 `usesExternalMemory` 守卫跳过 `consolidateRecentMemory` / `syncDocumentMemory` / `scanHistoryForStableFacts`（省 token，因为它不再被检索）。

**本地保留（常驻层 + 情绪引擎）：**
- structured `memory` / `user_profile` / 知识图谱工具：仍写本地、`buildSystem` 每轮全量注入（`memoryToPromptBlock` / `profileToPromptBlock`）。
- 情绪/心理引擎：`observeUserInput/Output` 仍跑情绪 delta + `render()`；`heartbeat` 仍做情绪衰减、主动打招呼、dream；dream 块仍注入。
- `update_memory`（废弃工具）：仍写本地文件。

`session.json` 对话历史与记忆后端无关，始终本地。`SubconsciousAgent.usesExternalMemory` 是这条边界的开关。

---

## 5. 接线两处构造点

把 backend 从 config 创建出来传进构造函数。

### 5.1 `src/runCliPrompt.ts:53`

```ts
import { createExternalMemoryBackend } from './memory/external/agentmem.js'
// ...
const externalMemory = createExternalMemoryBackend(config)
const subconscious = new SubconsciousAgent(config, cwd, undefined, externalMemory)
```

### 5.2 `src/ui/ChatApp.tsx:399`

```ts
const externalMemory = createExternalMemoryBackend(config)
const agent = new SubconsciousAgent(config, cwd, liveUi, externalMemory)
```

> 其余测试里的 `new SubconsciousAgent(config, cwd)` 不传第 4 参，行为不变（本地记忆）。

---

## 6. 配置入口（UI）

### 6.1 InitWizard（`src/ui/InitWizard.tsx`）

`Step` 联合类型加 `'memoryBackend' | 'memoryBaseUrl' | 'memoryKey'`，在 `apiKey` 步之后、`askMore`/`done` 之前插入可选三步：

1. `memoryBackend`：问「是否启用外部记忆（AgentMem）？」y/n。n → 跳过后两步。
2. `memoryBaseUrl`：输入服务根 URL（默认 `https://agentmem.oyii.ai`）。
3. `memoryKey`：输入 Memory-Key（`mem_...`）。

写入 `config.memory = { backend: 'agentmem', agentmem: { baseUrl, apiKey } }`。

### 6.2 `/config` Live 面板

Live 模式 `/config`（`ui/chatSlashCommands.ts` 的 `{ kind: 'config' }`）面板加两个字段：**记忆服务 URL** 和 **Memory-Key**，以及一个 backend 开关（local / agentmem）。保存时复用 §2.2 的解析与写盘逻辑。

### 6.3 直接编辑 config.json

也支持手填：

```json
{
  "memory": {
    "backend": "agentmem",
    "agentmem": {
      "baseUrl": "https://agentmem.oyii.ai",
      "apiKey": "mem_xxx",
      "topK": 6,
      "timeoutMs": 8000
    }
  }
}
```

---

## 7. 测试计划

新增 `src/memory/external/agentmem.test.ts`（vitest，mock 全局 `fetch`）：

- `query` 正常：mock 返回 `{ injected_context: "..." }` → 返回该串。
- `query` 缺字段 / 非字符串 → 返回 `''`。
- `query` HTTP 401 / 500 → 返回 `''`，不抛。
- `query` 超时（fetch reject / abort）→ 返回 `''`。
- `add` 正常：断言 URL、`X-Memory-API-Key`、`Idempotency-Key` 头、body `{user_input, agent_response}`。
- `add` 失败（4xx / 超时）→ resolve，不抛。
- `createExternalMemoryBackend`：缺 baseUrl 或 apiKey、backend≠agentmem → `undefined`。

`SubconsciousAgent` 行为测试（扩展 `subconscious/agent.test.ts`）：

- 注入 fake backend：`observeUserInput` + `observeAssistantOutput` → backend.add 收到配对的 `(user, output)`。
- `retrieveRelevantMemory` → 调 backend.query，返回带标题的上下文块。
- backend 存在时不触发本地 consolidate/refine（可通过 spy 本地函数未被调用断言）。

config 解析测试（扩展 `config/io.test.ts`）：

- 合法 `memory.agentmem` 往返解析；尾斜杠被去掉。
- 缺 apiKey → `memory.agentmem` 被丢弃（视为未启用）。
- `upgrade`/merge 保留既有 `memory` 段。

---

## 8. 范围外 / 可选扩展

下列**本期不做**，文档记录以备后续：

- **Memory 生命周期管理 CLI**：`infiniti-agent memory create/list/delete`，需要再配一把 **Admin-Key**（`X-Admin-API-Key: adm_...`，端点 `/v1/admin/memories`）。当前假设用户从 AgentMem 控制台拿到 `mem_...` 直接填配置。
- **混合 / Augment 模式**：保留 `mode` 字段位以后扩展；当前 `backend=agentmem` 即纯 Replace。
- **多 Memory 切换**：现有 `/memory switch` 是本地记忆工作区概念；与外部 Memory-Key 的映射关系如需打通，另立设计。

---

## 9. 落地顺序建议

1. §2 config 类型 + 解析（可单测，无副作用）。
2. §3 backend 客户端 + §7 客户端单测。
3. §4 coordinator 接入 + §5 两处接线 + §7 行为测试。
4. §6 配置入口（InitWizard → /config 面板）。
5. README 增补一节「外部记忆（AgentMem）」，指向本文。

每步可独立编译、独立验证；前三步完成即具备完整运行能力，UI 仅为易用性。
