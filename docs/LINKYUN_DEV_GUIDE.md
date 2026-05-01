# LinkYun 生态开发与调试手册

> 与 `LINKYUN_ECOSYSTEM.md` 配套：前者讲 **what**（架构 / API / 数据流），本文讲 **how**（怎么用、怎么本地起、怎么调试）。
> 4 个仓库 + 5 个终端 + 1 张联调图，看完能把全栈跑通。

---

## 0. 关系一句话

```text
linkyun-agent  =  整个生态的"心脏"，所有数据/鉴权/路由的真理源
                  ↓
       ┌──────────┼─────────────┬──────────────┐
       │          │             │              │
linkyun-agent-ui  edge-proxy  infiniti-agent   amp.linkyun.co
（浏览器端）   （边缘 LLM 执行）（桌面 CLI）   （邮件桥子域）

所有分支都用 X-API-Key 或 X-Edge-Token 调"心脏"，
分支彼此不直连，全部经"心脏"中转。
```

---

## 1. 联调启动总览（一图看顺序）

```text
              基础设施          后端           三个客户端
              ────────          ────           ──────────
  ┌─────────────────────┐
  │ Step 1                │
  │ docker compose up      │
  │ (MySQL :3306,           │
  │  Redis  :6379,           │
  │  Chroma :8000)            │
  └─────────────┬─────────┘
                │
                ▼
          ┌─────────────────────────┐
          │ Step 2                    │
          │ go run cmd/server/main.go │  → 监听 :8080
          │ 自动 migrate up            │
          └────┬─────────┬────────┬──┘
               │         │        │
               ▼         ▼        ▼
       ┌──────────┐ ┌──────────┐ ┌──────────┐
       │ Step 3   │ │ Step 4   │ │ Step 5   │
       │ Creator  │ │ User Hub │ │ Edge     │
       │ UI       │ │ (Vite)   │ │ Proxy    │
       │ :3000    │ │ :5173    │ │ TUI      │
       └──────────┘ └──────────┘ └──────────┘

  ┌─────────────────────────┐
  │ Step 6（可选，独立）     │
  │ infiniti-agent CLI/Live │  本机自治，sync/link 时才触后端
  └─────────────────────────┘
```

启动依赖：**1 → 2 → 任选 (3 ‖ 4 ‖ 5)**；Step 6 几乎独立。

---

## 2. 每个项目"如何使用"

### 2.1 `linkyun-agent` — 后端

| 角色 | 操作 |
|---|---|
| 自部署运维 | `docker compose -f deployments/docker/docker-compose.yml up -d` |
| 后端开发者 | `go run cmd/server/main.go` |
| DB 维护 | `go run ./cmd/migrate up` / `down` |
| 备份 | `go run ./cmd/backup` |
| 修账号 | `go run ./cmd/fix-account` |
| 手测 API | `go build -o client-cli ./client-cli && ./client-cli`（交互式） |

**最小可用 `.env`**（基于 `@D:\linkyun-agent\.env.example`，实际调试后的全量列表）：

```bash
SERVER_PORT=8080
DB_HOST=localhost          # 本地 docker compose 用 localhost，远端基础设施使用实际 IP
DB_USERNAME=linkyun
DB_PASSWORD=<填>
DB_DATABASE=linkyun_agent
REDIS_HOST=localhost
LLM_PROVIDER=openai        # gemini | claude | openai
OPENAI_API_KEY=<填>
API_KEY_ENCRYPTION_KEY=<openssl rand -hex 32>

# CORS 白名单——覆盖 4 个浏览器端全部可能端口 × (localhost 与 127.0.0.1)：
#   :3000  client-web-ui (Next.js Creator)
#   :3001  备用 / next dev 冲突时自切
#   :5173  lumina-ai-chat-hub 与 linkyun-app (Vite 共用)
#   :5180  linkyun-app 另一个同时跑实例
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:5173,http://localhost:5180,http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:5173,http://127.0.0.1:5180

# 知识库 RAG——使用本地部署的 BGE（8080 上的 linkyun-agent + 远端 Chroma + 远端 BGE）
KNOWLEDGE_CHROMA_ENDPOINT=http://192.168.200.131:8000
KNOWLEDGE_CHROMA_TIMEOUT=30s
KNOWLEDGE_EMBEDDING_PROVIDER=local                # 必须是非 "openai" / "tongyi" 才会走自定义 baseURL——参见 §6 第 14 条
KNOWLEDGE_EMBEDDING_MODEL=bge-base-zh-v1.5        # 输出 768 维；bge-large-zh-v1.5 为 1024 维
EMBEDDING_BASE_URL=http://10.0.23.117:3011/v1
EMBEDDING_API_KEY=                                # 本地 BGE 不验证就留空；不要写 "sk-"——参见 §6 第 14 条
```

#### 2.1.1 Motherland 配置（系统级 AI 创作助手）

**概念**：Motherland（母体 / 世界核心智能体）是被任命为「Creator 创作助手」的某个普通 Agent 引用，存储于 `system_config` 表（key=`motherland_agent_id`）。被任命的 Agent 会被 client-web-ui 调用以提供 3 项能力：优化提示词、生成头像、生成人设稿。**未任命时这些功能在 UI 上是隐藏的**。

**3 个 admin CLI 命令**（`@D:\linkyun-agent\cmd\linkyun-admin-cli\main.go:185-188`）：

```powershell
go run .\cmd\linkyun-admin-cli motherland-set <agent-id 或 code>   # 任命
go run .\cmd\linkyun-admin-cli motherland-unset                    # 取消
go run .\cmd\linkyun-admin-cli motherland-show                     # 查看当前
```

**5 个 HTTP API**（`@D:\linkyun-agent\internal\api\handler\system.go`）：

| Endpoint | 鉴权 | 用途 |
|---|---|---|
| `GET /api/v1/system/motherland-status` | 无 | 公开查 Motherland 是否已配置（dashboard 启动时调） |
| `POST /api/v1/system/talk-to-motherland` | X-API-Key | Creator 让某 Agent 与 Motherland 对话（A2A） |
| `POST /api/v1/system/auto-talk-round` | X-API-Key | 一轮自动对话（Agent ↔ Motherland） |
| `POST /api/v1/system/motherland-chat-history` | X-API-Key | 拿历史 |
| `POST /api/v1/system/motherland-chat-reset` | X-API-Key | 清空 A2A 会话 |

**设置三步流程**：

```powershell
# Step 1: 在 client-web-ui 创建专门的 Motherland Agent，记下它的 id 或 code
#   建议名: "Linkyun Architect" / "母体智能体"
#   建议 code: "motherland" / "linkyun-architect"
#   prompt 用下方推荐模板，model 选你的最强模型

# Step 2: 任命
cd D:\linkyun-agent
go run .\cmd\linkyun-admin-cli motherland-set linkyun-architect

# Step 3: 验证（CLI + HTTP 双重）
go run .\cmd\linkyun-admin-cli motherland-show
Invoke-RestMethod -Uri "http://localhost:8080/api/v1/system/motherland-status"
# 期望: configured=True, agent_id=<刚才那个>
```

**推荐的 Motherland system prompt 模板**（生产建议，直接粘到 Creator UI 的 Agent prompt 区）：

```text
你是 Linkyun Architect ——专为 Creator 服务的 Agent 设计资深顾问。

# 你的核心职责
1. 帮 Creator 打磨 Agent 的人设、提示词、技能组合，让目标 Agent 在自己的细分场景里表达更精准、更有人味、更稳定。
2. 把 Creator 的模糊意图（"我想要个温柔点的助手"）转译成可执行的 prompt 工程动作（具体修哪一行、加什么 example、删什么冲突约束）。
3. 在保持 Linkyun 平台一致性的前提下，鼓励 Creator 的差异化表达。

# 你的工作模式
- **先澄清，再建议**：每轮先用 1-2 个针对性问题确认 Creator 的真实意图与边界，再给具体改写方案。永远不要在信息不全时硬猜。
- **结构化输出**：每次回应分三段——「我的理解」「具体建议」「下一步问题」。每段不超过 3 个要点。
- **范例驱动**：给改写建议时，必须配 1-2 个完整的 prompt 片段示例（可直接复制到 Agent 配置），不要只给抽象描述。
- **数据敏感**：当 Creator 提到某个 Agent 时，先调用工具查它当前的 prompt / 技能 / 近期对话，不要凭空推荐。

# 你的边界
- 你**不替** Creator 做最终决定。当 Creator 已表态某种风格偏好，即使你认为不优，也按他的偏好继续打磨，但可在第三段提一次"另一种思路"。
- 你**不**给出涉及违法、伤害、突破 Linkyun 平台规则的建议。
- 你**不**在创作话题外漫谈（如政治、医疗、投资建议）。

# 你的语气
专业、克制、像有 8 年经验的 senior product designer 在做 1-on-1 工作坊。中文为主，关键术语保留英文（如 "system prompt" / "few-shot"）。
```

**与 client-web-ui 的耦合点**：dashboard layout 启动时调 `getMotherlandStatus()`（`@D:\linkyun-agent-ui\client-web-ui\src\app\dashboard\layout.tsx:49`）。**未配置时 3 个 motherland 技能按钮在 UI 上隐藏**；配置后浏览器刷新即解锁，不需重启后端。

---

### 2.2 `linkyun-agent-ui` + `linkyun-app` — 浏览器端（3 个独立前端）

| 子项目 | 角色 | 路径 | 启动 | 前端默认端口 | 源码内嵌后端默认值 |
|---|---|---|---|---|---|
| `client-web-ui` | Creator（创建/管理 Agent） | `D:\linkyun-agent-ui\client-web-ui` | `npm run dev` | 3000 | **`:8081`** ⚠️与后端默认端口不符，必须覆盖 |
| `lumina-ai-chat-hub` | End User（与 Agent 对话，老版 SPA） | `D:\linkyun-agent-ui\client-user-hub\lumina-ai-chat-hub` | `npm run dev` | 5173 | `:8080` ✅零配置 |
| `linkyun-app` | End User PWA（新 H5 客户端，第 5 仓库） | `D:\linkyun-app` | `pnpm dev` | 5173 / 5180 | `:8080` ✅零配置 |

**最小 `.env.local`**（服件于本机后端 `:8080`）：

```bash
# client-web-ui——必须创建这个文件或启动时传 env var，否则连不上后端。参见 §6 第 12 条
NEXT_PUBLIC_API_URL=http://localhost:8080

# lumina-ai-chat-hub——默认已对，可选覆盖
VITE_API_URL=http://localhost:8080

# linkyun-app——默认已对，可选覆盖
VITE_API_BASE_URL=http://localhost:8080
```

**PowerShell 临时覆盖**（不创建 `.env.local` 时）：

```powershell
cd D:\linkyun-agent-ui\client-web-ui
$env:NEXT_PUBLIC_API_URL = "http://localhost:8080"
npm run dev
```

UI 运行后也可以在浏览器 console 热切：

```js
localStorage.setItem('linkyun-api-url-override', 'http://localhost:8080') // client-web-ui
localStorage.setItem('lumina-api-url-override',  'http://localhost:8080') // lumina
localStorage.setItem('linkyun-app-api-base',     'http://localhost:8080') // linkyun-app
```

**生产部署**：在 `D:\linkyun-agent-ui` 根目录跑 `./setup.sh`，交互式问 4 个问题（部署哪些 UI、域名、是否同域代理），自动生成 `docker-compose.yml` + `nginx.conf` + 两个 `Dockerfile`，然后 `docker compose up -d --build`。

### 2.3 `edge-proxy` — 本地 Agent 执行

```bash
# 1. 在 Creator UI 创建 agent_type=edge 的 Agent，复制 et_xxx + agent_uuid
# 2. 把二进制 + skills/ + rules/ 拷到目标机器
# 3. 交互式向导生成配置
./scripts/configure.sh

# 4. 启动（自带 TUI）
./edge-proxy --config=edge-proxy-config.yaml
```

**最小 `edge-proxy-config.yaml`**：

```yaml
server_url: "http://localhost:8080"
edge_token: "et_xxx"            # 从 Creator UI 复制
agent_uuid: "<uuid>"            # 同上

llm:
  default: "ollama-local"
  providers:
    - name: "ollama-local"
      provider: "ollama"
      base_url: "http://localhost:11434"
      model: "qwen2.5:7b"

heartbeat_interval: 15s
poll_timeout: 30s
log_level: "info"
```

### 2.4 `infiniti-agent` — 桌面 Agent

```powershell
npm install -g linkyun-infiniti-agent
infiniti-agent init                  # 全局配 LLM
cd C:\my\project
infiniti-agent migrate               # 项目级隔离
infiniti-agent                       # TUI 对话
infiniti-agent live                  # + Live2D 透明窗
```

**三种入口**：

| 命令 | 用途 |
|---|---|
| `infiniti-agent` 或 `chat` | 交互 TUI（Ink+React） |
| `infiniti-agent cli <prompt>` | 单轮 stdout，嵌入 shell / cron / 邮件守护 |
| `infiniti-agent live` | TUI + Electron 透明窗（Live2D + TTS + ASR） |

**与 LinkYun 平台联动**（可选）：

```powershell
infiniti-agent sync               # 拉某个云端 Agent 的 SOUL.md / 角色稿
infiniti-agent link               # 从 SOUL.md 抽邮件配置，生成 mail-poller.sh
infiniti-agent generate_avatar    # OpenRouter 图像 API 生成头像
```

### 2.5 `linkyun-app` — 移动端 H5 专属命令

5 仓库生态的最新成员，独立于 `linkyun-agent-ui` mono-repo 单独建仓。Vite 8 + React 19 + Tailwind v4 + TanStack Router + Zustand。设计源自 Stitch 9 屏 mobile UI（iPhone 14-pro viewport 390×844）。启动方式与 `.env.local` 配置见 §2.2 浏览器端总表，本节聚焦 `linkyun-app` 专属开发命令矩阵：

| 角色 | 操作 |
|---|---|
| Mobile 前端开发 | `pnpm install && pnpm dev` |
| 测试 | `pnpm test:run` |
| 类型检查 | `pnpm typecheck` |
| Lint / Format | `pnpm lint` / `pnpm format:check` |
| 生产构建 | `pnpm build`（gzip ≤ 200KB 预算） |
| Bundle 分析 | `pnpm analyze` |

详细架构指针见 `linkyun-app` 仓 README + `linkyun-agent` 仓 OpenSpec change `linkyun-app-end-user-h5`。

---

## 3. 每个项目"本地开发调试"

### 3.1 `linkyun-agent`（Go + gorilla/mux）

| 维度 | 方法 |
|---|---|
| 热重载 | `go install github.com/air-verse/air@latest` 后 `air`；`go.mod` 未自带 |
| 断点 | GoLand / VS Code Go，target = `cmd/server/main.go` |
| 日志 | `LOG_LEVEL=debug` `LOG_FORMAT=json` |
| 单测 | `go test ./...` |
| 路由总览 | 直接看 `@D:\linkyun-agent\cmd\server\main.go:313-642`，全部 ~80 个路由集中在一个函数 |
| DB schema 同步 | `//go:embed migrations/*.sql` 嵌入二进制（`@D:\linkyun-agent\internal\db\migrate.go:14-15`）；启动自动 `migrate up`；手动 `go run ./cmd/migrate up`。表结构与系统种子数据（内置 skill / TTS 音色 / 母体配置等）均随迁移携带，**不需手工导入 schema.sql**。详见 `@D:\linkyun-agent\docs\项目功能介绍.md` 6.5.3 节 |
| DB 直查 | MySQL `linkyun_agent` 库，账号见 `.env` |
| Redis 直查 | `redis-cli`，按 `cfg.Redis.KeyPrefix`（默认 `linkyun:`）过滤 |
| Edge 队列查看 | `redis-cli LRANGE linkyun:edge:queue:<agent_uuid> 0 -1` |
| 共享 model 起点 | `@D:\linkyun-agent\internal\models\` 全部 23 个文件 |

### 3.2 `linkyun-agent-ui`（Next.js 15 + Vite + React）

| 维度 | 方法 |
|---|---|
| Creator UI 热重载 | Next.js dev 自带 |
| User Hub 热重载 | Vite HMR 自带 |
| 断点 | Chrome DevTools / VS Code Edge Tools |
| 网络面板 | DevTools Network 看 `/api/v1/*` |
| 类型源 | `@D:\linkyun-agent-ui\client-web-ui\src\lib\api.ts` 单文件 1859 行（API + 类型） |
| **运行时切环境** | console 里 `localStorage.setItem('linkyun-api-url-override', 'http://your-server')` 即可热切，不必重启 dev |
| Lint | 各子项目 `npm run lint` |

### 3.3 `edge-proxy`（Go + bubbletea TUI）

| 维度 | 方法 |
|---|---|
| 启动 | `go run cmd/main.go --config=edge-proxy-config.yaml` |
| 日志 | `log_level: debug` → TUI 左侧实时滚 |
| 断点 | dlv / GoLand。**TUI 接管 stdin/stdout，断点期间画面卡是正常的** |
| Mock 后端 | 起 fake server 实现 12 个 `/api/v1/edge/*`，把 `server_url` 指过去 |
| Skill 热加载 | `rules:` 已支持 fsnotify；`skills:` 需重启 |
| Token 校验失败排查 | 后端 `agents` 表 `edge_token` 字段必须以 `et_` 开头 |
| 本地 SQLite | `orders.db` 是工单缓存，**断线重连依赖它，别误删** |

### 3.4 `infiniti-agent`（Node 20 + tsx + vitest）

| 维度 | 方法 |
|---|---|
| 热重载（TUI） | `npm run dev`（tsx 自带） |
| CLI 模式 | `npm run dev -- cli 你好` |
| LiveUI 调试 | `npm run dev -- live --debug`，自动打开 DevTools |
| Electron 标题栏 | `INFINITI_LIVEUI_DEBUG_WINDOW=1` |
| Electron DevTools | `INFINITI_LIVEUI_DEVTOOLS=1` |
| 单测 | `npm test`（vitest） |
| 项目级隔离 | 全局 `~/.infiniti-agent/` 与项目级 `./.infiniti-agent/` 共存 |
| LLM 切档 | config.json 多 profile：`main` / `gate` / `compact` |
| 工具沙盒绕过 | `--dangerously-skip-permissions`（**仅自查**） |
| 邮件桥本地测试 | `mail-poller.sh --once`，日志在 `mail-poller.log` |
| 全局 link 本地版 | `npm run build && npm link` |

---

## 4. 全栈联调启动顺序（5 终端，可复制粘贴）

```text
═══════════════════════════════════════════════════════
 终端 1（基础设施，常驻）
═══════════════════════════════════════════════════════
cd D:\linkyun-agent\deployments\docker
docker compose -f docker-compose.infrastructure.yml up

═══════════════════════════════════════════════════════
 终端 2（后端，常驻）
═══════════════════════════════════════════════════════
cd D:\linkyun-agent
# 第一次：cp .env.example .env  并填几个关键值
go run .\cmd\server\main.go
# 等到 "Starting linkyun-agent server on 0.0.0.0:8080"

═══════════════════════════════════════════════════════
 终端 3（Creator UI，常驻）
═══════════════════════════════════════════════════════
cd D:\linkyun-agent-ui\client-web-ui
# 第一次：echo "NEXT_PUBLIC_API_URL=http://localhost:8080" > .env.local
npm run dev
# 浏览器开 http://localhost:3000，注册 Creator，复制 X-API-Key

═══════════════════════════════════════════════════════
 终端 4（Edge Proxy，常驻；仅当要测 edge agent）
═══════════════════════════════════════════════════════
cd D:\edge-proxy
# 第一次：./scripts/configure.sh，填上面拿到的 et_xxx
go run .\cmd\main.go --config=edge-proxy-config.yaml

═══════════════════════════════════════════════════════
 终端 5（User Hub，常驻；测 end user 视角）
═══════════════════════════════════════════════════════
cd D:\linkyun-agent-ui\client-user-hub\lumina-ai-chat-hub
# 第一次：echo "VITE_API_URL=http://localhost:8080" > .env.local
npm run dev
# 浏览器开 http://localhost:5173，与 edge agent 对话

═══════════════════════════════════════════════════════
 终端 6（linkyun-app，常驻；测 mobile end user 视角）
═══════════════════════════════════════════════════════
cd D:\linkyun-app
# 第一次：echo "VITE_API_BASE_URL=http://localhost:8080" > .env.local
pnpm install
pnpm dev
# 浏览器开 http://localhost:5180，从 mobile viewport (390×844) 体验 9 屏 H5
```

**最快验证全链路通的方法**：

1. 终端 3 创建 `agent_type=edge` 的 Agent → 复制 token
2. 终端 4 启动 edge-proxy（用上一步的 token）
3. 终端 5 给这个 Agent 发消息
4. 看终端 4 的 TUI 是否有 `EdgeRequest` 流入并被本地 LLM 处理
5. 终端 5 应该收到响应

---

## 5. 调用链全景

```text
                      End User Browser
                     ┌─────────────────┐
                     │  User Hub       │  X-API-Key
                     │  (Vite SPA)     │─────────────┐
                     └─────────────────┘             │
                                                      ▼
                                         ┌──────────────────────┐
       Creator Browser                   │                      │
       ┌─────────────────┐  X-API-Key    │   linkyun-agent      │
       │  Creator UI     │───────────────│   (Go HTTP, :8080)   │
       │  (Next.js)      │               │                      │
       └─────────────────┘               │  ─MySQL─ ─Redis─    │
                                          │                      │
                                          └──┬─────────┬─────┬───┘
                                             │         │     │
                                             │         │     │ Long-poll
                                  X-API-Key  │   X-Edge-Token │
                                             │         │     │
                                             │         │     ▼
                  Desktop                    │         │   ┌──────────────┐
                  ┌─────────────────┐        │         │   │ edge-proxy   │
                  │ infiniti-agent  │────────┘         └──▶│ (Go TUI)     │
                  │ (Node CLI/      │                       │  ┌────────┐ │
                  │  Electron)      │                       │  │  本地  │ │
                  └────┬────────────┘                       │  │  LLM   │ │
                       │                                    │  │(Ollama │ │
                       │ ws (本机)                          │  │  /...) │ │
                       ▼                                    │  └────────┘ │
                  ┌──────────┐                              └──────────────┘
                  │ LiveUI   │
                  │ Electron │
                  │ Live2D   │
                  └──────────┘

旁路 1: amp.linkyun.co/messages/inbox/*  ←──  infiniti-agent link （X-API-Key）
旁路 2: edge-proxy → /api/v1/edge/notify  ──→ User Hub SSE （非应答通道，状态/异步结果）
旁路 3: linkyun-agent → MultiProvider LLM API （Gemini/Claude/OpenAI/...）
旁路 4: linkyun-agent → Motherland Service → 同上 LLM （创作者制作 Agent 的辅助）
```

调用链说明：

- **Cloud Agent 流**：UI → 后端 → MultiProvider LLM → 流式回 UI
- **Edge Agent 流**：UI → 后端入队 Redis → edge-proxy long poll 拿到 → 本地 LLM 跑 → `/edge/stream-respond` 回传 → 后端 Pub/Sub → UI SSE
- **infiniti-agent 同步流**：CLI `sync` → 后端 `/api/v1/agents/{id}` → 写本地 `SOUL.md`
- **邮件桥流**：邮件用户 → amp.linkyun.co inbox → infiniti-agent `mail-poller.sh` 长轮询 → `cli` 单轮 → 写回 inbox processed

---

## 6. 容易踩的坑

下面几条**不在任何 README**，但读源码时浮现，自己写客户端 / 起本地全栈时会撞上：

1. **后端 BRPop 比客户端 timeout 短 2s**（`@D:\linkyun-agent\internal\api\handler\edge.go:174-178`）— 自己实现 edge poll 客户端，请把 client 端 timeout 设在 30s，不要更长，否则 race。

2. **localStorage 可热切环境**（Creator UI 用 `linkyun-api-url-override`，User Hub 用 `lumina-api-url-override`）— 调试切环境不用重启 dev server，console 改一行就行。

3. **infiniti-agent LiveUI 默认占 :8080**（`@d:\infiniti-agent\README.md:108`）— 与后端撞，`infiniti-agent live -p 9000` 或环境变量 `INFINITI_LIVEUI_PORT=9000` 避开。

4. **edge-proxy `orders.db` 是工单缓存**（`@D:\edge-proxy\internal\proxy\order_cache.go`）— 断线重连依赖，被 git ignore，**别误删**。

5. **后端启动会自动 migrate up**（`@D:\linkyun-agent\cmd\server\main.go:120-122`）— 第一次跑空库，等几秒看 `Database connected` 就 OK；迁移失败则进程直接 fatal。

6. **CORS 默认 `*`**（`@D:\linkyun-agent\cmd\server\main.go:298-309`）— 开发期方便，但**生产环境**必须设 `CORS_ALLOWED_ORIGINS`。

7. **`X-Edge-Token` 与 `X-API-Key` 不是同一鉴权链**：edge endpoint 用 `EdgeHandler.authenticateEdgeToken`（直查 `agents.edge_token` 列），不走 `RequireCreatorAuth` 中间件。客户端**不要**两个 header 一起发。

8. **infiniti-agent 的 LLM 配置里 `disableTools: true`**：本机 ollama 模型多数不支持工具调用，必须加这个，否则首轮就报错。

9. **`linkyun-agent-ui/setup.sh` 末尾历史污染**：`@D:\linkyun-agent-ui\setup.sh:441-447` 混入了 `</think>` / `<｜tool▁calls▁begin｜>` 等 LLM 输出残留（不是 bash 代码）。bash 在 `echo ""` 后正常退出，污染段不会被执行；但用 lint / shellcheck 会告警。**本文档只做记录，不主动修复**。

10. **服务端 Connect 动态告知客户端 endpoint**（`@D:\linkyun-agent\internal\api\handler\edge.go:80-94`）— 写自定义 edge 客户端时，应该读 `queue_config` 字段拿到 poll/respond/heartbeat URL，而不是硬编码路径。这样未来后端切到 WebSocket 时客户端不用改。

11. **不需手工导入 schema.sql**— 项目用 `//go:embed migrations/*.sql` 把 54 对迁移文件嵌入二进制（`@D:\linkyun-agent\internal\db\migrate.go:14-15`），应用启动自动 `migrate up`，会一并应用表结构与系统种子数据（12 个迁移含 `INSERT INTO`：内置 skill 定义 / MiniMax TTS 音色列表 / 母体 Agent 配置 等）。新人常误以为要从生产 dump 导入，不需要也不应该—手工导入会破坏 `schema_migrations` 状态表。详细链路见 `@D:\linkyun-agent\docs\项目功能介绍.md` 6.5.3 节。

12. **`client-web-ui` 默认 `NEXT_PUBLIC_API_URL=http://localhost:8081` 与后端默认 `:8080` 不符**（`@D:\linkyun-agent-ui\client-web-ui\src\lib\api.ts:13`）— 项目本身不携带 `.env.local`，不覆盖会连不上后端。三种覆盖顺序：`localStorage['linkyun-api-url-override']`（运行时）＞ `NEXT_PUBLIC_API_URL`（启动时）＞ 默认 `:8081`。调试时推荐在启动脚本里设 `$env:NEXT_PUBLIC_API_URL="http://localhost:8080"`。参见 §2.2。

13. **邀请码是账号级全局门槛**（`@D:\linkyun-agent\internal\api\handler\auth.go:48-110`）— 后端 `/api/v1/auth/register` 是唯一注册接口，**所有前端都走同一个**，都要带 `invitation_code`（不区分 Creator/End-User）。历史上 `client-web-ui` 的注册 UI 与 API 客户端函数都缺该字段，2026-05-01 修复：`api.ts` `register()` 加第 4 参 + `login/page.tsx` 加邀请码输入框，以 `api.test.ts` 的类型断言锁定契约。`lumina-ai-chat-hub` 与 `linkyun-app` 本来就是合规的。创建邀请码用 `go run .\cmd\linkyun-admin-cli inv-add WELCOME 100`。

14. **`embedding` provider 路由逻辑不是广义的**（`@D:\linkyun-agent\internal\knowledge\embedding.go:24-50`）— `KNOWLEDGE_EMBEDDING_PROVIDER` 取值为 `"openai"` 或 `"tongyi"` 时 baseURL **写死**为官方地址，**会忽略 `EMBEDDING_BASE_URL`**；只有取其他值（如 `local` / `bge` / `siliconflow` 等任意字串）才走 `default` 分支读你自己填的 baseURL。另外 `EMBEDDING_API_KEY` 被设为非空字符串（如填 `"sk-"`）时会发 `Authorization: Bearer sk-`，本地 BGE 不校验 token 不出问题，但接严格验证的服务会 401。应留空让其 fallback 到 `OPENAI_API_KEY`（也可为空）。

---

## 7. 与 `LINKYUN_ECOSYSTEM.md` 的关系

| 问题 | 看哪份 |
|---|---|
| 这 4 个仓库的角色 / 鉴权 / 路由总表 / 数据流时序图 | `LINKYUN_ECOSYSTEM.md` |
| 怎么本地起、怎么调试、有什么坑 | 本文 |
| 未来工作（infiniti-agent 接 Edge 协议、Skills 跨仓库共享、Schema Drift 防御） | `LINKYUN_ECOSYSTEM.md` 第 9 章 |
| 单仓库内部细节（infiniti-agent 自己） | `PROJECT_OVERVIEW.md` |

两份文档**故意分开**：架构图和"how to run"如果混在一篇里会过长，分开后每篇都能独立翻阅。

---

## 8. 维护提示

修过任意一个仓库的部署 / 配置 / 启动方式后，请同步更新本文相应章节。重点关注：

- 端口变化（第 1 章总览图、第 4 章 5 终端命令）
- 新增 / 删除 endpoint（在 `LINKYUN_ECOSYSTEM.md` 第 4 章更新；本文一般不动）
- 新增鉴权 header（本文第 6 章 + `LINKYUN_ECOSYSTEM.md` 第 3 章）
- 新增依赖服务（本文第 1 章 + 2.1 节 `.env`）
