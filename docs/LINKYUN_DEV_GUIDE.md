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

**最小可用 `.env`**（基于 `@linkyun-agent/.env.example`，实际调试后的全量列表）：

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
#   :5173  lumina-ai-chat-hub (Vite)
#   :5180  linkyun-concept (Vite, mobile H5)
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

**3 个 admin CLI 命令**（`@linkyun-agent/cmd/linkyun-admin-cli/main.go:185-188`）：

```bash
go run ./cmd/linkyun-admin-cli motherland-set <agent-id 或 code>   # 任命
go run ./cmd/linkyun-admin-cli motherland-unset                    # 取消
go run ./cmd/linkyun-admin-cli motherland-show                     # 查看当前
```

**5 个 HTTP API**（`@linkyun-agent/internal/api/handler/system.go`）：

| Endpoint | 鉴权 | 用途 |
|---|---|---|
| `GET /api/v1/system/motherland-status` | 无 | 公开查 Motherland 是否已配置（dashboard 启动时调） |
| `POST /api/v1/system/talk-to-motherland` | X-API-Key | Creator 让某 Agent 与 Motherland 对话（A2A） |
| `POST /api/v1/system/auto-talk-round` | X-API-Key | 一轮自动对话（Agent ↔ Motherland） |
| `POST /api/v1/system/motherland-chat-history` | X-API-Key | 拿历史 |
| `POST /api/v1/system/motherland-chat-reset` | X-API-Key | 清空 A2A 会话 |

**设置三步流程**：

```bash
# Step 1: 在 client-web-ui 创建专门的 Motherland Agent，记下它的 id 或 code
#   建议名: "Linkyun Architect" / "母体智能体"
#   建议 code: "motherland" / "linkyun-architect"
#   prompt 用下方推荐模板，model 选你的最强模型

# Step 2: 任命
cd linkyun-agent
go run ./cmd/linkyun-admin-cli motherland-set linkyun-architect

# Step 3: 验证（CLI + HTTP 双重）
go run ./cmd/linkyun-admin-cli motherland-show
curl "http://localhost:8080/api/v1/system/motherland-status"
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

**与 client-web-ui 的耦合点**：dashboard layout 启动时调 `getMotherlandStatus()`（`@linkyun-agent-ui/client-web-ui/src/app/dashboard/layout.tsx:49`）。**未配置时 3 个 motherland 技能按钮在 UI 上隐藏**；配置后浏览器刷新即解锁，不需重启后端。

#### 2.1.2 实时事件推送（BE-004 / global-user-events）

**概念**：用户级 SSE 通道。每个登录用户对一个 endpoint 建立一条 SSE 连接，多事件类型在同一连接上多路复用，规避浏览器 HTTP/1.1 6-EventSource-per-origin 限制（多 chat tab 场景）。

**Endpoints**：

| Endpoint | 用途 | 备注 |
|---|---|---|
| `GET /api/v1/user/events/stream` | BE-004 用户级 SSE（多路复用 4 events） | 替换 30s 轮询 |
| `GET /api/v1/user/events?session_id=` | Legacy 会话级 SSE | 4 周 dual-publish 兼容期；前端 Phase B 切换后由 follow-up change 移除 |
| `POST /api/v1/user/chats/{id}/typing` | 打字指示器（BE-001c 整合） | 1v1 仅设 TTL 不 publish；group session 才 publish |

**4 个 typed event**（`event: <type>\ndata: <json>\n\n`）：

| `event:` | `data` 字段 | 触发源 |
|---|---|---|
| `moment_like` | `actor` / `moment_id` / `created_at` | 跨 creator 点赞（self-like 不触发） |
| `moment_comment` | `actor` / `moment_id` / `comment_id` / `created_at` | 跨 creator 评论 |
| `chat_message` | `session_id` / `sender` / `message_id` / `preview` / `created_at` | `PushService.PushMessage` / `InternalPushToSession` |
| `typing` | `session_id` / `user_id` / `expires_at` | group session typing POST |

**未实施**：`friend_request` event（仓内无 user-to-user friend 概念，待用户级好友功能引入时单独 change 加）。

**心跳**：每 20 秒（`SSE_HEARTBEAT_INTERVAL` env override）emit `: heartbeat\n\n` SSE comment——W3C 标准注释格式，前端 EventSource 自动忽略，仅用于绕过 nginx default `proxy_read_timeout 60s` 的 idle teardown。

**dual-publish 策略**（`chat_message` 专属，design.md D8）：4 周内每条 chat message 同时 publish 到 `linkyun:push:session:<sid>`（老 channel）和 `linkyun:push:user:<uid>`（新 channel），让前端 Phase B 切换期间老订阅不丢消息；cut-over 在 follow-up `remove-session-sse` change 做。

**Spec / 实现真源**：`@linkyun-agent/openspec/specs/global-user-events/spec.md`（archive 后路径）；handler 实现 `@linkyun-agent/internal/api/handler/user_events.go`；publisher `@linkyun-agent/internal/eventbus/publisher.go`；service hooks `@linkyun-agent/internal/service/moment_notification.go`（NotifyLike / NotifyComment）+ `@linkyun-agent/internal/service/push.go`（chat dual-publish）+ `@linkyun-agent/internal/service/chat_typing.go`（typing）。

#### 2.1.3 Agent 关注 / 主形象 / Follow 通知三件套

**能力背景**（spec 真源 `@linkyun-agent/openspec/specs/agent-follow/spec.md`）：2026-05 由 `social-graph` capability 升级而来。关注对象从「Creator」变为「Agent」——一个 Creator 可能为多个 Agent 各自别被关注。「主形象」（`creators.primary_agent_id`）是 Creator 可以选定某个 Agent 作为「代表他」的 anchor，用于 `is_mutual` 计算。

**6 个关键 endpoint 及调试命令**（需 X-API-Key + agent id）：

```bash
# 假设 $KEY = "<你的 X-API-Key>"
BASE="http://localhost:8080/api/v1"
AUTH_HEADER="X-API-Key: $KEY"
# 1. 关注 agent 12
curl -X POST -H "$AUTH_HEADER" "$BASE/agents/12/follow"

# 2. 查看关注状态（返 is_following / is_followed_by_owner / is_mutual / followed_at）
curl -H "$AUTH_HEADER" "$BASE/agents/12/follow-status"

# 3. 查看 agent 12 的粉丝列表
curl -H "$AUTH_HEADER" "$BASE/agents/12/followers?limit=20"

# 4. 查看我关注的 agents
curl -H "$AUTH_HEADER" "$BASE/me/agent-following?limit=20"

# 5. 取消关注（幂等 — 对已删除 agent 仍返 200，供清理遗留关系使用）
curl -X DELETE -H "$AUTH_HEADER" "$BASE/agents/12/follow"

# 6. 设置主形象（agent_id 必须是自己创建的 non-archived agent）
BODY='{"agent_id": 12}'
curl -X PUT -H "$AUTH_HEADER" -H "Content-Type: application/json" -d "$BODY" "$BASE/me/primary-agent"
```

**软删状态哥兵限定**（今日修定）：只有 `agents.status = 'archived'` 才是软删哥兵。对以上 4 个需要过滤 archived target 的 endpoint（POST / GET follow-status / GET followers / PUT primary-agent）会返 404。`DELETE /follow` 是唯一不检查状态的端点（幂等清理）。验证方法：

```bash
# 手工软删一个你的 agent
mysql -e "UPDATE agents SET status='archived' WHERE id=12;" linkyun_agent

# 期望 404
curl -X POST -H "$AUTH_HEADER" "$BASE/agents/12/follow"
# 期望 200 + 列表不含该 agent
curl -H "$AUTH_HEADER" "$BASE/me/agent-following"

# 恢复
mysql -e "UPDATE agents SET status='active' WHERE id=12;" linkyun_agent
```

**与 moment-notifications 的联动**：`POST /agents/{id}/follow` 同事务后会 fire-and-forget 调 `MomentNotificationService.NotifyFollow`，为 target agent owner 插入一条 follow 通知。`NotifyFollow` 本身会二次检查 archived 状态作为防御（`@linkyun-agent/internal/service/moment_notification.go:226`）。检查通知列表：

```bash
curl -H "$AUTH_HEADER" "$BASE/me/notifications?type=follow&limit=20"
```

**与 legacy `social-graph` 的共存**：老 5 路由（`POST /follow` / `GET /follow/status` / etc）仍服务但添 deprecation header，2026-07-01 sunset。前端 SDK 依赖 `Link: <successor>; rel="successor-version"` 响应头自动重写。定义 `@linkyun-agent/cmd/server/main.go:572-590`。决定背景：`@linkyun-agent/openspec/changes/archive/2026-05-22-add-agent-follow/design.md`。

**5 实体 soft-delete sentinel 速查**（`ECOSYSTEM §3.5` 是真源）：

| 实体 | sentinel | 过滤 |
|---|---|---|
| Creator / User / Session / Workspace | `status = 'deleted'` | `!= 'deleted'` |
| **Agent** | **`status = 'archived'`** | **`!= 'archived'`** |

代码中出现 `agent.Status == "deleted"` 或 `ag.status != 'deleted'` 都是 bug。设计源：`@linkyun-agent/openspec/changes/archive/2026-05-24-normalize-agent-soft-delete-status/design.md`。

---

### 2.2 `linkyun-agent-ui` + `linkyun-concept` — 浏览器端（3 个独立前端）

| 子项目 | 角色 | 路径 | 启动 | 前端默认端口 | 源码内嵌后端默认值 |
|---|---|---|---|---|---|
| `client-web-ui` | Creator（创建/管理 Agent） | `linkyun-agent-ui/client-web-ui` | `npm run dev` | 3000 | **`:8081`** ⚠️与后端默认端口不符，必须覆盖 |
| `lumina-ai-chat-hub` | End User（与 Agent 对话，老版 SPA） | `linkyun-agent-ui/client-user-hub/lumina-ai-chat-hub` | `npm run dev` | 5173 | `:8080` ✅零配置 |
| `linkyun-concept` | End User Mobile H5（OYIIOYII Figma 设计，第 5 仓库，代替 `linkyun-app`） | `linkyun-concept` | `pnpm dev` | 5180 | `:8080` ✅零配置 |

**最小 `.env.local`**（服件于本机后端 `:8080`）：

```bash
# client-web-ui——必须创建这个文件或启动时传 env var，否则连不上后端。参见 §6 第 12 条
NEXT_PUBLIC_API_URL=http://localhost:8080

# lumina-ai-chat-hub——默认已对，可选覆盖
VITE_API_URL=http://localhost:8080

# linkyun-concept——默认已对，可选覆盖；mode 驱动 .env.development / .env.production / .env.local
VITE_API_BASE_URL=http://localhost:8080/api/v1
```

**命令行临时覆盖**（不创建 `.env.local` 时）：

```bash
# Linux / macOS / Git Bash 上走 bash
cd linkyun-agent-ui/client-web-ui
export NEXT_PUBLIC_API_URL="http://localhost:8080"
npm run dev
```

```powershell
# Windows PowerShell 等价写法
cd linkyun-agent-ui/client-web-ui
$env:NEXT_PUBLIC_API_URL = "http://localhost:8080"
npm run dev
```

UI 运行后也可以在浏览器 console 热切：

```js
localStorage.setItem('linkyun-api-url-override', 'http://localhost:8080') // client-web-ui
localStorage.setItem('lumina-api-url-override',  'http://localhost:8080') // lumina
localStorage.setItem('linkyun-app-api-base',     'http://localhost:8080') // linkyun-concept (key 历史名保留兼容)
```

**生产部署**：在 `linkyun-agent-ui` 根目录跑 `./setup.sh`，交互式问 4 个问题（部署哪些 UI、域名、是否同域代理），自动生成 `docker-compose.yml` + `nginx.conf` + 两个 `Dockerfile`，然后 `docker compose up -d --build`。

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

```bash
npm install -g linkyun-infiniti-agent
infiniti-agent init                  # 全局配 LLM
cd ~/projects/my-project
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

```bash
infiniti-agent sync               # 拉某个云端 Agent 的 SOUL.md / 角色稿
infiniti-agent link               # 从 SOUL.md 抽邮件配置，生成 mail-poller.sh
infiniti-agent generate_avatar    # OpenRouter 图像 API 生成头像
```

### 2.5 `linkyun-concept` — 移动端 H5 专属命令

生态第 5 仓库，独立仓 `linkyun-concept`。**代替早期 `linkyun-app`**（后者 Stitch 9 屏 设计，现已废弃）。技术栈：Vite 8 + React + TypeScript + Wrangler（Cloudflare Workers Static Assets）。设计源自 Figma OYIIOYII AI 偶像 H5。启动方式与 `.env.local` 配置见 §2.2 浏览器端总表，本节聚焦 `linkyun-concept` 专属开发命令矩阵：

| 角色 | 操作 |
|---|---|
| Mobile 前端开发 | `pnpm install && pnpm dev`（:5180） |
| 单测 | `pnpm test:run`（Vitest，~60 unit，`TZ=Asia/Shanghai`） |
| E2E 测试 | `pnpm test:e2e`（Playwright Chromium happy-path，3 specs，需后端 :8080 在跑） |
| E2E UI 模式 | `pnpm test:e2e:ui`（Playwright 交互式 UI） |
| 类型检查 | `pnpm typecheck`（`tsc --noEmit`） |
| Lint / Format | `pnpm lint` / `pnpm format:check` |
| 生产构建 | `pnpm build`（`tsc -b && vite build`，Rolldown） |
| 本地预览 | `pnpm preview` |

**生产部署**：Cloudflare Workers Static Assets（`wrangler.toml`）。CI 调 `pnpm install && pnpm build` + `npx wrangler deploy`，上传 `dist/` 到 CF Workers，`not_found_handling = "single-page-application"` 让任意路径返 `index.html` 供 TanStack Router client-side routing。**本地从不跱 wrangler——`pnpm dev/build` 独立于 CF 管道**。

**Mode-driven .env**：Vite 根据 mode 自动选 `.env`：`pnpm dev` 默认 `development` mode 走 `.env.development`（绑 `localhost:8080`），`pnpm build` 走 `.env.production`（绑 `linkyun.co`）。`.env.local` / `.env.[mode].local` 个人 override且 git ignored。运行时优先级（高覆盖低）：`localStorage['linkyun-app-api-base']`（历史名保留）> `VITE_API_BASE_URL`（编译时注入）。

**与 `linkyun-agent` 后端的协作**：`linkyun-concept` 是 `docs/cross-repo-requests/` brief 的主要发送方。近 1 周 12+ 份 backend-* request 几乎全来自 concept（参见 §2.7）。

详细架构指针见：`linkyun-concept` 仓 `README.md` + `AGENTS.md` + 本仓 archived OpenSpec change `linkyun-app-end-user-h5`（初始设计，linkyun-app 时期）。linkyun-concept 自带 16 个前端 OpenSpec spec（`agent-follow-frontend` / `companions` / `app-shell` / `discovery` / `me` / `notifications` / `auth` / `design-system` / `dev-tools` 等） + 54 个 archived change。

---

### 2.6 OpenSpec 工作流（变更管理）

LinkYun 后端所有非琐碎改动（≥30 min 工作量、影响 spec、改公共 API、新增 capability、改 DB schema）都走 OpenSpec 流程。**新人必读**：仓里 `openspec/` 目录是 spec / change / archive 的真源。`AGENTS.md §3` 是工作流权威。

**4 个 artifact**：

| 文件 | 作用 |
|---|---|
| `openspec/changes/<name>/proposal.md` | Why + 影响范围 + 用户可见行为变化 |
| `openspec/changes/<name>/design.md` | 决策日志（D1, D2, ...）+ 风险（R1, ...）+ 备选方案 |
| `openspec/changes/<name>/specs/<capability>/spec.md` | spec delta（`## ADDED/MODIFIED/REMOVED Requirements`），归档时折叠进主 spec |
| `openspec/changes/<name>/tasks.md` | 实施步骤 + 验证 grep + DoD 检查清单 |

**核心 CLI**（仓里通过 `npm install -g @stelee410/openspec-cli` 或 `npx` 调用）：

```bash
openspec list                                           # 列当前 active changes
openspec list --json                                    # JSON 输出，给脚本用
openspec validate <change-name> --strict                # 验证 4 artifact 完整性 + delta 语法
openspec validate <capability>                          # 验证主 spec
openspec show <capability>                              # 查看主 spec
openspec archive <change-name> --yes                    # 归档：折叠 delta 进主 spec + 移到 archive/<YYYY-MM-DD>-<name>/
openspec sync <change-name>                             # 仅同步 delta 到主 spec，不归档
```

**Windsurf workflows**（`/`-命令）：

| 命令 | 用途 |
|---|---|
| `/dev <想法>` | 启动新 change（OpenSpec + Superpowers 强点融合：探索 → 提议 → TDD → 审查 → 验证 → 归档） |
| `/dev continue` | 推进现有 change |
| `/opsx-explore` | 进入探索模式（思考分区，不实施） |
| `/opsx-new` | 启动新 change（实验性轻量工作流） |
| `/opsx-propose` | 一步生成完整 proposal + design + spec + tasks |
| `/opsx-apply` | 实施 tasks |
| `/opsx-verify` | 实施完成后验证 |
| `/opsx-archive` | 归档单个 change |
| `/opsx-bulk-archive` | 一次归档多个并行 change |
| `/opsx-sync` | 仅同步 delta，不归档 |

详见 `@linkyun-agent/.windsurf/workflows/dev.md`。

**典型 lifecycle**（小修走快道，大改走 dev）：

```text
小修（<30 min）        → 直接 commit，不走 OpenSpec
新增 capability         → /dev → propose → apply → verify → archive
修复语义 bug             → /opsx-new → 4 artifact → apply → archive（今日 normalize-agent-soft-delete-status 走的就是此路）
跨能力 spec 重构        → /dev 全套 + cross-repo brief
```

**实践示例**：今日 ship 的 `normalize-agent-soft-delete-status` 经过 8 个 commits（proposal → design → specs → tasks → 实施 → cross-repo brief → archive → 跨仓 docs sync）。归档后 spec delta 折叠进 `agent-follow` + `moment-notifications` 两个主 spec。归档目录在 `@linkyun-agent/openspec/changes/archive/2026-05-24-normalize-agent-soft-delete-status\`。

---

### 2.7 Cross-repo brief 约定（跨仓沟通）

LinkYun 五仓生态的跨仓协作通过 `docs/cross-repo-*` 文件进行——异步、可审计、可回溯。

**两种文件**：

| 路径 | 用途 | 触发方 |
|---|---|---|
| `docs/cross-repo-requests/<topic>-<YYYY-MM-DD>.md` | 仓 A 向仓 B 提需求或问询 | 通常前端 → 后端 |
| `docs/cross-repo-responses/<topic>-<YYYY-MM-DD>.md` | 仓 B 给仓 A 的实施回执或答复 | 通常后端 → 前端 |

**何时写 brief**（必须）：

- 新加 / 修改 / 删除公共 API endpoint
- 修改鉴权头 / 鉴权逻辑
- 修改 DB schema（影响多仓 model 复制时）
- 修改 wire-shape 即响应/请求 JSON 结构
- 修改 SSE / WebSocket / 长轮询协议
- HTTP 状态码 contract 变化（如 200 → 404）

**Brief 内容范式**（参考 `@linkyun-agent/docs/cross-repo-responses/agent-soft-delete-semantics-shipped-2026-05-24.md`）：

```text
1. TL;DR / 一句话
2. 三个面影响（before / after 表）
3. 没变的部分（重点 callout，避免误改）
4. Spec lock / 实现指针 / commit 链
5. 前端建议跟进步骤
6. DoD 检查清单
7. Out of scope 跟进项
```

**如何回应 brief**：

```bash
# 1. 读 request brief
code linkyun-agent/docs/cross-repo-requests/<topic>-<YYYY-MM-DD>.md

# 2. 评估、走 OpenSpec change（如需）、实施

# 3. 在 docs/cross-repo-responses/ 写回执
touch linkyun-agent/docs/cross-repo-responses\<topic>-shipped-<YYYY-MM-DD>.md

# 4. commit + push 时让前端仓的 reviewer 在 PR review 时看到
```

**与 OpenSpec 的关系**：cross-repo brief 不替代 OpenSpec change。Brief 是给**其他仓**看的精炼版本（影响 + 行动）；OpenSpec 是给本仓的设计决策记录。两者并存。

**当前 active brief**（截至 2026-05-24）：

| 文件 | 状态 |
|---|---|
| `docs/cross-repo-responses/agent-soft-delete-semantics-shipped-2026-05-24.md` | 今日 ship |
| `docs/cross-repo-responses/primary-agent-auto-clear-shipped-2026-05-24.md` | 已 ship |
| `docs/cross-repo-responses/primary-agent-endpoint-shipped-2026-05-22.md` | 已 ship |
| `docs/cross-repo-responses/frontend-primary-agent-consumed-2026-05-23.md` | 前端确认 |

**来自 linkyun-concept 的 backend-* request brief**（1 周内，表明主要跨仓协作通道）：

| 文件 | 状态 |
|---|---|
| `docs/cross-repo-requests/backend-archived-vs-deleted-status-2026-05-24.md` | 内部 backlog（已 ship via normalize-agent-soft-delete-status） |
| `docs/cross-repo-requests/backend-primary-agent-auto-clear-on-delete-2026-05-24.md` | 已 ship（commit 702a2e4） |
| `docs/cross-repo-requests/backend-primary-agent-endpoint-2026-05-22.md` | 已 ship |
| `docs/cross-repo-requests/backend-agents-follow-migration-2026-05-21.md` | 已 ship |
| `docs/cross-repo-requests/backend-companion-status-feed-2026-05-20.md` | 待评估 |
| `docs/cross-repo-requests/backend-follow-notification-2026-05-19.md` | 待评估 |
| `docs/cross-repo-requests/backend-likes-received-followup-2026-05-18.md` | 待评估 |
| `docs/cross-repo-requests/backend-social-graph-and-likes-received-2026-05-17.md` | 待评估 |
| `docs/cross-repo-requests/backend-me-agents-stats-aggregation-2026-05-23.md` | 待评估 |
| `docs/cross-repo-requests/backend-notification-actor-primary-agent-2026-05-23.md` | 待评估 |

新增 brief 时同步更新本表。待评估的多在等后端 bandwidth 或 OpenSpec change 拆解。

---

## 3. 每个项目"本地开发调试"

### 3.1 `linkyun-agent`（Go + gorilla/mux）

| 维度 | 方法 |
|---|---|
| 热重载 | `go install github.com/air-verse/air@latest` 后 `air`；`go.mod` 未自带 |
| 断点 | GoLand / VS Code Go，target = `cmd/server/main.go` |
| 日志 | `LOG_LEVEL=debug` `LOG_FORMAT=json` |
| 单测 | `go test ./...` |
| 路由总览 | 直接看 `@linkyun-agent/cmd/server/main.go:313-642`，全部 ~80 个路由集中在一个函数 |
| DB schema 同步 | `//go:embed migrations/*.sql` 嵌入二进制（`@linkyun-agent/internal/db/migrate.go:14-15`）；当前 64 对；启动自动 `migrate up`；手动 `go run ./cmd/migrate up`。表结构与系统种子数据（内置 skill / TTS 音色 / 母体配置等）均随迁移携带，**不需手工导入 schema.sql**。详见 `@linkyun-agent/docs/项目功能介绍.md` 6.5.3 节 |
| DB 直查 | MySQL `linkyun_agent` 库，账号见 `.env` |
| Redis 直查 | `redis-cli`，按 `cfg.Redis.KeyPrefix`（默认 `linkyun:`）过滤 |
| Edge 队列查看 | `redis-cli LRANGE linkyun:edge:queue:<agent_uuid> 0 -1` |
| 共享 model 起点 | `@linkyun-agent/internal/models\` 全部 23 个文件 |

### 3.2 `linkyun-agent-ui`（Next.js 15 + Vite + React）

| 维度 | 方法 |
|---|---|
| Creator UI 热重载 | Next.js dev 自带 |
| User Hub 热重载 | Vite HMR 自带 |
| 断点 | Chrome DevTools / VS Code Edge Tools |
| 网络面板 | DevTools Network 看 `/api/v1/*` |
| 类型源 | `@linkyun-agent-ui/client-web-ui/src/lib/api.ts` 单文件 1859 行（API + 类型） |
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
cd linkyun-agent/deployments/docker
docker compose -f docker-compose.infrastructure.yml up

═══════════════════════════════════════════════════════
 终端 2（后端，常驻）
═══════════════════════════════════════════════════════
cd linkyun-agent
# 第一次：cp .env.example .env  并填几个关键值
go run ./cmd/server/main.go
# 等到 "Starting linkyun-agent server on 0.0.0.0:8080"

═══════════════════════════════════════════════════════
 终端 3（Creator UI，常驻）
═══════════════════════════════════════════════════════
cd linkyun-agent-ui/client-web-ui
# 第一次：echo "NEXT_PUBLIC_API_URL=http://localhost:8080" > .env.local
npm run dev
# 浏览器开 http://localhost:3000，注册 Creator，复制 X-API-Key

═══════════════════════════════════════════════════════
 终端 4（Edge Proxy，常驻；仅当要测 edge agent）
═══════════════════════════════════════════════════════
cd edge-proxy
# 第一次：./scripts/configure.sh，填上面拿到的 et_xxx
go run ./cmd/main.go --config=edge-proxy-config.yaml

═══════════════════════════════════════════════════════
 终端 5（User Hub，常驻；测 end user 视角）
═══════════════════════════════════════════════════════
cd linkyun-agent-ui/client-user-hub/lumina-ai-chat-hub
# 第一次：echo "VITE_API_URL=http://localhost:8080" > .env.local
npm run dev
# 浏览器开 http://localhost:5173，与 edge agent 对话

═══════════════════════════════════════════════════════
 终端 6（linkyun-concept，常驻；测 mobile end user 视角）
═══════════════════════════════════════════════════════
cd linkyun-concept
# 默认已携 .env.development 走 localhost:8080，需 override 才创 .env.local
pnpm install
pnpm dev
# 浏览器开 http://localhost:5180，从 mobile viewport 体验 OYIIOYII AI 偶像 H5
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

1. **后端 BRPop 比客户端 timeout 短 2s**（`@linkyun-agent/internal/api/handler/edge.go:174-178`）— 自己实现 edge poll 客户端，请把 client 端 timeout 设在 30s，不要更长，否则 race。

2. **localStorage 可热切环境**（Creator UI 用 `linkyun-api-url-override`，User Hub 用 `lumina-api-url-override`）— 调试切环境不用重启 dev server，console 改一行就行。

3. **infiniti-agent LiveUI 默认占 :8080**（`@infiniti-agent/README.md:108`）— 与后端撞，`infiniti-agent live -p 9000` 或环境变量 `INFINITI_LIVEUI_PORT=9000` 避开。

4. **edge-proxy `orders.db` 是工单缓存**（`@edge-proxy/internal/proxy/order_cache.go`）— 断线重连依赖，被 git ignore，**别误删**。

5. **后端启动会自动 migrate up**（`@linkyun-agent/cmd/server/main.go:120-122`）— 第一次跑空库，等几秒看 `Database connected` 就 OK；迁移失败则进程直接 fatal。

6. **CORS 默认 `*`**（`@linkyun-agent/cmd/server/main.go:298-309`）— 开发期方便，但**生产环境**必须设 `CORS_ALLOWED_ORIGINS`。

7. **`X-Edge-Token` 与 `X-API-Key` 不是同一鉴权链**：edge endpoint 用 `EdgeHandler.authenticateEdgeToken`（直查 `agents.edge_token` 列），不走 `RequireCreatorAuth` 中间件。客户端**不要**两个 header 一起发。

8. **infiniti-agent 的 LLM 配置里 `disableTools: true`**：本机 ollama 模型多数不支持工具调用，必须加这个，否则首轮就报错。

9. **`linkyun-agent-ui/setup.sh` 末尾历史污染**：`@linkyun-agent-ui/setup.sh:441-447` 混入了 `</think>` / `<｜tool▁calls▁begin｜>` 等 LLM 输出残留（不是 bash 代码）。bash 在 `echo ""` 后正常退出，污染段不会被执行；但用 lint / shellcheck 会告警。**本文档只做记录，不主动修复**。

10. **服务端 Connect 动态告知客户端 endpoint**（`@linkyun-agent/internal/api/handler/edge.go:80-94`）— 写自定义 edge 客户端时，应该读 `queue_config` 字段拿到 poll/respond/heartbeat URL，而不是硬编码路径。这样未来后端切到 WebSocket 时客户端不用改。

11. **不需手工导入 schema.sql**— 项目用 `//go:embed migrations/*.sql` 把 64 对迁移文件嵌入二进制（`@linkyun-agent/internal/db/migrate.go:14-15`），应用启动自动 `migrate up`，会一并应用表结构与系统种子数据（12 个迁移含 `INSERT INTO`：内置 skill 定义 / MiniMax TTS 音色列表 / 母体 Agent 配置 等）。新人常误以为要从生产 dump 导入，不需要也不应该—手工导入会破坏 `schema_migrations` 状态表。详细链路见 `@linkyun-agent/docs/项目功能介绍.md` 6.5.3 节。

12. **`client-web-ui` 默认 `NEXT_PUBLIC_API_URL=http://localhost:8081` 与后端默认 `:8080` 不符**（`@linkyun-agent-ui/client-web-ui/src/lib/api.ts:13`）— 项目本身不携带 `.env.local`，不覆盖会连不上后端。三种覆盖顺序：`localStorage['linkyun-api-url-override']`（运行时）＞ `NEXT_PUBLIC_API_URL`（启动时）＞ 默认 `:8081`。调试时推荐在启动脚本里设 `export NEXT_PUBLIC_API_URL="http://localhost:8080"`（PowerShell 等价：`$env:NEXT_PUBLIC_API_URL="http://localhost:8080"`）。参见 §2.2。

13. **邀请码是账号级全局门槛**（`@linkyun-agent/internal/api/handler/auth.go:48-110`）— 后端 `/api/v1/auth/register` 是唯一注册接口，**所有前端都走同一个**，都要带 `invitation_code`（不区分 Creator/End-User）。历史上 `client-web-ui` 的注册 UI 与 API 客户端函数都缺该字段，2026-05-01 修复：`api.ts` `register()` 加第 4 参 + `login/page.tsx` 加邀请码输入框，以 `api.test.ts` 的类型断言锁定契约。`lumina-ai-chat-hub` 与 `linkyun-app` 本来就是合规的（**注**：2026-05-12 后 `linkyun-app` 被 `linkyun-concept` 替代，concept 也合规）。创建邀请码用 `go run ./cmd/linkyun-admin-cli inv-add WELCOME 100`。

14. **`embedding` provider 路由逻辑不是广义的**（`@linkyun-agent/internal/knowledge/embedding.go:24-50`）— `KNOWLEDGE_EMBEDDING_PROVIDER` 取值为 `"openai"` 或 `"tongyi"` 时 baseURL **写死**为官方地址，**会忽略 `EMBEDDING_BASE_URL`**；只有取其他值（如 `local` / `bge` / `siliconflow` 等任意字串）才走 `default` 分支读你自己填的 baseURL。另外 `EMBEDDING_API_KEY` 被设为非空字符串（如填 `"sk-"`）时会发 `Authorization: Bearer sk-`，本地 BGE 不校验 token 不出问题，但接严格验证的服务会 401。应留空让其 fallback 到 `OPENAI_API_KEY`（也可为空）。

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
