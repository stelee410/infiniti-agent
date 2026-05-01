# LinkYun 生态架构文档

> 把 LinkYun 平台四个仓库的关系、协议、数据流串起来，作为新人 onboarding 与跨仓库改动的唯一参考。
> 所有文件路径、行号、endpoint、字段都来自代码，不是猜测。

---

## 1. 一图概览

```text
GitHub stelee410/
├── linkyun-agent       — Go HTTP 后端（D:\linkyun-agent）            ← cloud backend
├── linkyun-agent-ui    — Next.js + Vite 前端（D:\linkyun-agent-ui）  ← user-facing UI
├── edge-proxy          — Go TUI 长轮询客户端（D:\edge-proxy）        ← edge runtime
├── infiniti-agent      — Node CLI/Electron（D:\infiniti-agent）      ← 本地桌面 Agent
└── linkyun-app         — Vite + React 19 SPA（D:\linkyun-app）       ← mobile H5 client

                ┌───────────────────────────────────────────────────┐
                │  linkyun-agent  (Go, gorilla/mux, :8080)          │
                │  ─────────────────────────────────────────────    │
                │  MySQL  : creators / agents / sessions / messages │
                │           creator_skills / knowledge_bases / ...  │
                │  Redis  : SessionCache + EdgeQueue + Pub/Sub      │
                │  LLM    : MultiProvider (Gemini/Claude/OpenAI/    │
                │           GLM/Qwen/Doubao/MiniMax)                │
                │  特殊   : Motherland Service (创作者侧 system     │
                │           agent，做提示词优化、角色稿生成)         │
                │  外部桥 : amp.linkyun.co/messages/...（邮件桥）   │
                └───────────────────────────────────────────────────┘
                  ▲              ▲              ▲              ▲
       X-API-Key  │   X-API-Key  │   X-API-Key  │  X-Edge-Token│
                  │              │              │              │
        ┌─────────┴───┐  ┌───────┴──────┐  ┌────┴──────┐  ┌────┴────────┐
        │ client-web- │  │ lumina-ai-   │  │ infiniti- │  │ edge-proxy  │
        │ ui          │  │ chat-hub     │  │ agent     │  │             │
        │ (Creator)   │  │ (End User)   │  │ (Node)    │  │ (Go TUI)    │
        │ Next.js 15  │  │ Vite SPA     │  │ CLI/TUI/  │  │ 长轮询      │
        │             │  │              │  │ Live2D    │  │ +本地 LLM   │
        │ 在 :8081 跑 │  │ 在 :8080 跑   │  │ +TTS/ASR  │  │ +Skills     │
        │             │  │              │  │           │  │ +Rules.mdc  │
        └─────────────┘  └──────────────┘  │  - sync   │  │ +MCP/Sandbox│
                         ┌──────────────┐  │  - link   │  │ +SQLite     │
                         │ linkyun-app  │  │  - cli    │  └─────────────┘
                         │ (End User    │  └─────┬─────┘
                         │  Mobile)     │        │ ws (本机)
                         │ Vite SPA     │        ▼
                         │ 在 :5180 跑  │ ┌──────────────┐
                         │ 9 屏 Stitch  │ │ Electron     │
                         │ Tweaks . PWA │ │ LiveUI 渲染端│
                         └──────────────┘ └──────────────┘
```

---

## 2. 五仓库一句话定位

| 仓库 | git remote | 语言 / 模块 | 核心职责 |
|---|---|---|---|
| **linkyun-agent** | `stelee410/linkyun-agent` | Go 1.24 / `linkyun-agent` | 全平台真理源：用户/Agent/会话/消息/Skills/知识库/朋友圈，承载 `api.linkyun.co` |
| **linkyun-agent-ui** | `stelee410/linkyun-agent-ui` | TS / Next.js + Vite | 浏览器界面，分 Creator UI（`client-web-ui`，:8081）和 User Hub（`lumina-ai-chat-hub`，:8080） |
| **edge-proxy** | `stelee410/edge-proxy` | Go 1.24 / `linkyun-edge-proxy` | 把 Agent 执行下放到本地：长轮询拿请求 → 本地 LLM 跑 → 推回云端，支持 11 种 LLM、Skills、Rules、MCP、Sandbox、TTS |
| **infiniti-agent** | `stelee410/infiniti-agent` | Node 20 / `linkyun-infiniti-agent` | 个人桌面 Agent CLI：自带 LiveUI（Live2D + TTS + ASR）+ 邮件守护 + 项目级独立空间，可独立运行也可同步云端 |
| **linkyun-app** | `stelee410/linkyun-app` | TS / Vite + React 19 | 移动端 H5 End User 客户端：iPhone 14-pro viewport 390×844，9 屏 Stitch 设计；与 lumina-ai-chat-hub 共享后端，运行端口 :5180 |

---

## 3. 鉴权矩阵（5 种 token / header）

| Header | 颁发方 | 持有者 | 解析位置 | 用于 |
|---|---|---|---|---|
| `X-API-Key` | `/api/v1/auth/login` 返回，存 `creators.api_key` | Creator 三端：client-web-ui / infiniti-agent / 部分 lumina-hub | `@D:\linkyun-agent\internal\api\middleware\auth.go` | 全部 `protected.*` 路由 |
| `X-Edge-Token` | Creator 在 UI 创建 edge agent 时生成（前缀 `et_`） | edge-proxy（每实例绑一个 agent uuid） | `@D:\linkyun-agent\internal\api\handler\edge.go:46` | `/api/v1/edge/*` |
| `X-Internal-API-Key` | `.env` 配置 | 服务端内部脚本 | `RequireCreatorOrInternalAuth` | `/api/v1/user/push-messages` |
| `X-Share-User-Code` | 分享访客 cookie | 公开分享对话访客 | `RequireGuestAuth` | `/api/v1/public/share/{token}/...` |
| `X-Workspace-Code` | Creator 选定 workspace 后 | infiniti-agent `linkyunSync.ts`（UI 暂未用） | `WorkspaceHandler` | 工作区作用域过滤 |

---

## 4. API 路由全景（按鉴权分组）

源代码：`@D:\linkyun-agent\cmd\server\main.go:313-642`，全 ~80 个 endpoint 集中在一个 `setupHTTPServer()` 中注册。下面只列**涉及客户端交互**的核心子集。

### 4.1 公开 `api`（无鉴权）

| Endpoint | Handler | 注册行 | 调用方 |
|---|---|---|---|
| `POST /api/v1/auth/login` | `authHandler.Login` | `main.go:324` | UI、infiniti-agent |
| `POST /api/v1/auth/register` | `authHandler.Register` | `main.go:323` | UI |
| `POST /api/v1/auth/refresh-key` | `authHandler.RefreshKey` | `main.go:325` | infiniti-agent |
| `GET /api/v1/avatars/{filename}` | `agentHandler.ServeAvatar` | `main.go:447` | UI、infiniti-agent（`<img src>` 直连） |
| `GET /api/v1/character-sheets/{filename}` | `agentHandler.ServeCharacterDesignSheet` | `main.go:449` | 同上 |
| `GET /api/v1/files/{token}/download` | `fileHandler.Download` | `main.go:605` | edge-proxy 拉附件 |

### 4.2 Creator `protected`（X-API-Key）

| 用途分类 | 主要 endpoint | Handler 文件 |
|---|---|---|
| 资料 | `GET/PUT /profile`、`POST/DELETE /profile/avatar`、`PUT /profile/password` | `@D:\linkyun-agent\internal\api\handler\profile.go` |
| Agent CRUD | `GET/POST /agents`、`GET/PUT/DELETE /agents/{id}`、`/by-code/{code}`、`/discover`、`/{id}/publish` | `@D:\linkyun-agent\internal\api\handler\agent.go` |
| Agent 头像 | `POST/DELETE /agents/{id}/avatar`、`POST /agents/{id}/avatar/generate-preview` | 同上 |
| 角色设定 | `POST /agents/{id}/optimize-narrative`、`POST /agents/{id}/character-design/generate-spec\|generate-sheet\|save` | 同上（**调 Motherland Agent**） |
| Edge 管理 | `POST /agents/{id}/edge-token/reset`、`POST /agents/{id}/simulate` | 同上 |
| Workspace | `/workspaces` 全套 + `/user/workspace/*` | `workspace.go` |
| 朋友圈 | `/agents/{id}/moments` 全套、`/moments` | `moment.go` |
| 知识库 | `/knowledge-bases` 全套 + `/documents/*` | `knowledge_base.go` / `document.go` |
| Skills | `/skills`、`/skills/marketplace`、`/creator-skills` 全套、`/agents/{id}/{pre\|mid\|post}-skills` | `creator_skill.go` |
| 会话 | `/sessions` 全套、`PATCH /sessions/{id}/prompt` (**God View**) | `session.go` |
| 消息 | `POST /sessions/{session_id}/messages`、`/messages/{id}` | `message.go` |
| 1v1 / 群聊 | `/user/chats/*`、`/user/group-chats/*` | `user_chat.go` / `group_chat.go` |
| 文件 | `POST /files/upload\|upload-document\|upload-moment-image` | `file.go` |
| 推送 | `/user/notifications/*`、`/user/events`（SSE） | `notification.go` / `sse.go` |
| Motherland | `POST /system/talk-to-motherland\|auto-talk-round\|generate-topic\|motherland-chat-history\|motherland-chat-reset` | `system.go` |

### 4.3 Edge `api`（X-Edge-Token，无 protected wrapper）

注册段：`@D:\linkyun-agent\cmd\server\main.go:580-609`

| Endpoint | Handler | 用途 |
|---|---|---|
| `POST /api/v1/edge/connect` | `edgeHandler.Connect` | 上线，服务端返回 queue_config |
| `POST /api/v1/edge/disconnect` | `edgeHandler.Disconnect` | 下线 |
| `POST /api/v1/edge/heartbeat` | `edgeHandler.Heartbeat` | 心跳，默认 15s |
| `GET /api/v1/edge/poll?agent_uuid=&timeout=` | `edgeHandler.Poll` | 长轮询，BRPop 30s |
| `POST /api/v1/edge/respond` | `edgeHandler.Respond` | 单次应答 |
| `POST /api/v1/edge/stream-respond` | `edgeHandler.StreamRespond` | NDJSON 流式 chunk |
| `POST /api/v1/edge/notify` | `edgeHandler.Notify` | 主动推送（save_to_db 控制是否持久化） |
| `POST /api/v1/edge/files/upload` | `fileHandler.Upload` | 边缘端上传产物（如 TTS 音频） |
| `GET /api/v1/edge/memories?agent_uuid=&user_id=` | `edgeMemoryHandler.ListMemories` | 拉取记忆 |
| `POST /api/v1/edge/memories` | `edgeMemoryHandler.CreateMemory` | 新增记忆 |
| `POST /api/v1/edge/memories/delete-by-keyword` | `edgeMemoryHandler.DeleteByKeyword` | 按关键字删除 |

### 4.4 邮件桥 `amp.linkyun.co`（X-API-Key）

| Endpoint | 调用方 | 文件 |
|---|---|---|
| `GET /messages/inbox/{boxId}/unprocessed` | infiniti-agent `link.ts` | `@d:\infiniti-agent\src\link.ts:54-59` |
| `POST /messages/inbox/{boxId}/processed` | 同上 | 同文件 |

amp 是独立子域，可能在同一个 `linkyun-agent` 进程上挂另一个虚拟主机，也可能是另一个微服务（仓库内未发现 amp 的 Go handler，可能由反向代理转发到第三方邮件服务）。

---

## 5. 数据流详解

### 5.1 Cloud Agent 消息流（最常见）

```text
End User                lumina-ai-chat-hub          linkyun-agent              MultiProvider LLM
   │                            │                          │                          │
   │  发送消息                   │                          │                          │
   ├──────────────────────────►│                          │                          │
   │                            │  POST /sessions/{id}/   │                          │
   │                            │  messages (X-API-Key)    │                          │
   │                            ├─────────────────────────►│                          │
   │                            │                          │  入队 Worker Pool         │
   │                            │                          │  组装 prompt            │
   │                            │                          │  (system + memory +     │
   │                            │                          │   God View patch)       │
   │                            │                          │  跑 pre_conversation    │
   │                            │                          │     skills              │
   │                            │                          ├─────────────────────────►│
   │                            │                          │      流式 chunk          │
   │                            │                          │◄─────────────────────────┤
   │                            │                          │  跑 post_conversation   │
   │                            │   SSE                    │     skills (TTS 等)      │
   │                            │◄─────────────────────────┤                          │
   │  渲染                       │                          │                          │
   │◄───────────────────────────┤                          │                          │
```

### 5.2 Edge Agent 消息流（关键差异）

```text
End User      lumina-hub      linkyun-agent             edge-proxy           本地 LLM
   │              │                  │                       │                   │
   │              │              【启动时】                    │                   │
   │              │                  │  POST /edge/connect   │                   │
   │              │                  │◄──────────────────────┤                   │
   │              │                  │  返回 queue_config    │                   │
   │              │                  ├──────────────────────►│                   │
   │              │                  │  POST /edge/heartbeat │                   │
   │              │                  │◄──────────────────────┤  (每 15s)         │
   │              │                  │                       │                   │
   │              │                  │  GET /edge/poll       │                   │
   │              │                  │◄──────────────────────┤  (BRPop 挂起 28s)  │
   │  发消息       │                  │                       │                   │
   ├─────────────►│  /sessions/{id}/ │                       │                   │
   │              │  messages        │                       │                   │
   │              ├─────────────────►│                       │                   │
   │              │                  │  EdgeQueue 入队        │                   │
   │              │                  │  → Redis Pub          │                   │
   │              │                  │  Poll BRPop 命中       │                   │
   │              │                  ├──────────────────────►│  EdgeRequest      │
   │              │                  │                       │  ┌──────────────┐ │
   │              │                  │                       │  │ Rules注入     │ │
   │              │                  │                       │  │ pre skills   │ │
   │              │                  │                       │  │ MCP tools    │ │
   │              │                  │                       │  └──────┬───────┘ │
   │              │                  │                       ├────────►│         │
   │              │                  │                       │◄────────┤  流式    │
   │              │                  │                       │  ┌──────┴──────┐  │
   │              │                  │                       │  │ post skills │  │
   │              │                  │                       │  │ (TTS 等)    │  │
   │              │                  │                       │  └──────┬──────┘  │
   │              │                  │  POST /edge/stream-   │         │         │
   │              │                  │       respond (NDJSON)│         │         │
   │              │                  │◄──────────────────────┤         │         │
   │              │   SSE            │  发布 Pub/Sub          │         │         │
   │              │◄─────────────────┤                       │         │         │
   │  渲染         │                  │                       │         │         │
   │◄─────────────┤                  │  POST /edge/notify    │         │         │
   │              │                  │◄──────────────────────┤  (异步状态/结果)   │
```

设计要点：
- 服务端 BRPop 超时（28s）比客户端 HTTP timeout（30s）短 2s，避免 race（`@D:\linkyun-agent\internal\api\handler\edge.go:174-178`）
- `/edge/notify` 是离应答通道之外的旁路，能在不破坏会话顺序的前提下推"思考中…"或异步 TTS 音频

### 5.3 Motherland 流（创作者制作 Agent 时的辅助）

`Motherland Service`（`@D:\linkyun-agent\cmd\server\main.go:206`）是一个**系统级 Agent**，`creators` 表中预置一个 motherland creator + agent，用平台默认 LLM。
当 Creator 在 UI 中触发：
- `optimize-narrative` → 拿当前提示词稿、近期对话喂给 motherland，输出优化后的 system prompt
- `character-design/generate-spec` → 多模态输入（提示词+头像+对话），输出角色设定文本
- `character-design/generate-sheet` → 设定文本 → 漫画式角色稿（Nano Banana / Gemini 多图模型）
- `avatar/generate-preview` → 同管线，单张半身像

infiniti-agent 的 `generate_avatar` 命令（`@d:\infiniti-agent\src\cli\generateAvatar.ts`）走的是另一条路 — 直接用 OpenRouter 图像 API，不经过 motherland。

### 5.4 邮件守护流（infiniti-agent 独有）

```text
邮件用户  →  邮件服务商  →  amp.linkyun.co/messages/inbox    →  MySQL inbox 表
                                                                    │
                                                                    │ 长轮询
                                                                    ▼
                                                  infiniti-agent (linkyun-mail-poller.sh)
                                                          │
                                                          ▼
                                                  cli <prompt> 单轮 → LLM 回复
                                                          │
                                                          ▼
                                                  POST processed → 邮件回执
```

`@d:\infiniti-agent\src\cli\generateMailPollerScript.ts` 生成 watch shell 脚本。

### 5.5 infiniti-agent 同步流

`infiniti-agent sync` → 读 `.infiniti-agent/config.json` 中的 LinkYun 凭证 →
1. `GET /api/v1/agents` 列出 cloud agents
2. 用户选一个 → `GET /api/v1/agents/{id}` 拉详情
3. 写到当前目录 `SOUL.md`、`INFINITI.md`、`.infiniti-agent/character_sheet.png`

代码：`@d:\infiniti-agent\src\cli\linkyunSync.ts`。

---

## 6. Skills 协议（cloud ↔ edge 对齐）

| 维度 | cloud | edge |
|---|---|---|
| 三阶段 | `pre_conversation` / `mid_conversation` / `post_conversation` | 同名 |
| 三类型 | `prompt-based` / `prompt-api` / `code` | 同名 |
| 配置存储 | DB `creator_skills` 表 | `D:\edge-proxy\skills/<name>/SKILL.{json\|yaml\|md}` |
| 内置 skill | `@D:\linkyun-agent\internal\skills\builtin.go`、`builtin_post.go`、`minimaxi_tts.go`、`create_docx.go` | `current-time` / `get_weather` / `voice-tts` / `web_search` / `trending` / `trending_hackernews` |
| Pipeline | `@D:\linkyun-agent\internal\skills\pipeline.go` | `@D:\edge-proxy\internal\skills\pipeline.go` |
| 注入 SystemPrompt | pre 阶段 | pre 阶段 + Rules 引擎 (.mdc 热加载) |
| TTS 实现 | MiniMax (`minimaxi_tts.go`) | OpenAI / MiniMax (`internal/tts/`) |

**当前协议 gap**：creator 在云端配的 `creator_skills` 不会自动下发到 edge-proxy 的本地目录。Edge 实例的 skill 只能由部署者手动放进 `skills/`。

infiniti-agent 自己有第三套 skill 体系（`.infiniti-agent/skills/<id>/SKILL.md`），格式与 edge-proxy 接近，但执行器是 Node 实现，不能直接互通。

---

## 7. 部署拓扑

### 7.1 生产

| 域名 | 服务 | 端口 |
|---|---|---|
| `api.linkyun.co` | linkyun-agent | :443（反向代理到 :8080） |
| `amp.linkyun.co` | 邮件桥（同进程或独立） | :443 |
| `app.linkyun.co` / 等 | linkyun-agent-ui 静态托管 | :443 |

linkyun-agent 部署需要：MySQL 8.0 + Redis 6.0 + ChromaDB（向量库，`KNOWLEDGE_CHROMA_ENDPOINT`）。

### 7.2 开发

```text
你的开发机:
  :8080 ── linkyun-agent (Go)              （go run cmd/server/main.go）
  :8081 ── client-web-ui (Next.js dev)     （npm run dev）
  :5173 ── lumina-ai-chat-hub (Vite dev)   （npm run dev，但配置默认指向 :8080）
  :5180 ── linkyun-app (Vite dev)         （pnpm dev）
  :3306 ── MySQL
  :6379 ── Redis
  :8000 ── Chroma（可选）

  本机 edge-proxy (任意端口，对外不暴露，只做出站长轮询):
    server_url: http://localhost:8080
    edge_token: et_xxx (从 UI 复制)

  本机 infiniti-agent (Node CLI):
    .infiniti-agent/config.json:
      linkyun.apiBase = http://localhost:8080  (或 https://api.linkyun.co)
```

### 7.3 Edge 部署

把 `edge-proxy.exe` + `edge-proxy-config.yaml` + `skills/` + `rules/` 拷到任意机器，唯一外部依赖是能访问 `api.linkyun.co`。本地 LLM 可选 Ollama（完全离线）或调用云端 OpenAI 兼容 API。

### 7.4 数据库与基础设施同步链路

**Schema 来源**：`@D:\linkyun-agent\internal\db\migrations\` 共 54 对 `.up.sql/.down.sql`，通过 `//go:embed migrations/*.sql` 嵌入二进制（`@D:\linkyun-agent\internal\db\migrate.go:14-15`）。运行时不依赖磁盘上的 SQL 文件。

**应用方式**：
- 启动时自动：`@D:\linkyun-agent\cmd\server\main.go:120` 在 `initializeApp` 首步调用 `db.Up(dsn)`。
- 手动 CLI：`go run ./cmd/migrate {up|down|version|force <ver>}`。
- Bash 包装：`./scripts/migrate.sh up`。

**状态跟踪**：MySQL 内 `schema_migrations` 表由 golang-migrate 自动建与维护，记录 (version, dirty)。dirty=1 表示上次迁移中途崩溃，需 `migrate force <ver>` 手动清理。

**种子数据**：12 个迁移文件含 `INSERT INTO`，覆盖：内置 skill 定义 / MiniMax TTS 音色列表（000023 单文件 27KB） / 母体 Agent 配置 / 敏感词过滤 等系统级数据。**不需手工 dump SQL 导入**——`init.sql` 仅创建空库，schema 与系统种子数据全部随 migrate 同步落地。用户业务数据（账号 / Agent / 会话）不走迁移，由 API 运行时创建。

**Redis / Valkey 兼容**：项目客户端 `go-redis/v8` 走 RESP 协议；Valkey 8 是 Redis 7.2.4 的 BSD fork，协议与命令集完全兼容，可直接复用同一容器。所有 key 走 `linkyun:` 前缀，与他项目共享同 db 不会撞。

**Chroma 版本**：项目代码走 v2 API（`@D:\linkyun-agent\internal\knowledge\chroma.go:36-39`），镜像必须 `chromadb/chroma:latest` ≥ 0.5。

具体部署步骤（虚拟机 + 本机服务的远程模式）见 `@D:\linkyun-agent\docs\项目功能介绍.md` 6.5 节。

---

## 8. 关键文件速查

| 想找什么 | 文件 |
|---|---|
| 后端所有路由 | `@D:\linkyun-agent\cmd\server\main.go:313-642` |
| Edge 协议服务端 | `@D:\linkyun-agent\internal\api\handler\edge.go` |
| Edge 协议客户端 | `@D:\edge-proxy\internal\proxy\proxy.go` |
| Cloud LLM 路由 | `@D:\linkyun-agent\internal\llm\` (Multi-Provider) |
| Cloud Skills 引擎 | `@D:\linkyun-agent\internal\skills\pipeline.go` |
| Edge Skills 引擎 | `@D:\edge-proxy\internal\skills\pipeline.go` |
| UI Creator 入口 | `@D:\linkyun-agent-ui\client-web-ui\src\lib\api.ts` |
| UI End User 入口 | `@D:\linkyun-agent-ui\client-user-hub\lumina-ai-chat-hub\services\api.ts` |
| infiniti-agent 同步 | `@d:\infiniti-agent\src\cli\linkyunSync.ts` |
| infiniti-agent 邮件桥 | `@d:\infiniti-agent\src\link.ts` |
| 共享 Edge model | `@D:\linkyun-agent\internal\models\edge.go` |
| Agent DB schema | `@D:\linkyun-agent\internal\models\agent.go` |
| 数据库迁移 | `@D:\linkyun-agent\internal\db\migrations\` |
| schema 状态表 | MySQL `schema_migrations`（golang-migrate 自动维护，记录 version + dirty） |

---

## 9. 未来工作（高层 PLAN）

下面三个方向按"投入/价值"排序。每条只给方向和落点，不展开 EXECUTE 级别细节 — 你 `ENTER PLAN MODE` 后我可以为任意一条产出可执行的精确 PLAN。

### 9.1 让 infiniti-agent 接入 Edge 协议（高价值）

**目标**：让 Creator 在云端 UI 上看到"我的桌面 Live Agent 在线"，把 Live2D + 个性化记忆作为 edge 能力暴露给云端用户。

**落点**：
- 新增 `@d:\infiniti-agent\src\edge/`：`client.ts`（HTTP 长轮询）、`protocol.ts`（mirror `models.EdgeResponse/EdgeStreamChunk` 字段）、`session.ts`（绑定到 `.infiniti-agent/` 项目）
- CLI 新增子命令 `infiniti-agent edge --token=et_xxx`，复用 `runChatTui` 现有 LLM 循环
- `config.json` 加 `edge: { token, agentUuid, serverUrl }` 节
- `runToolLoop` 流式输出转换为 `/edge/stream-respond` 的 NDJSON
- LiveUI 表情/TTS 走 `/edge/notify` 旁路（save_to_db=false）
- 测试：在 mock server 上验证 12 个 endpoint 全通

**风险**：本地 token 安全（不能写进 git）、断线重连、与 cli 模式互斥。

### 9.2 Skills 协议跨仓库共享（中价值）

**目标**：Creator 在 cloud UI 配的 skill 能下发到所有该 agent 关联的 edge-proxy 实例。

**落点**：
- 新增 `GET /api/v1/edge/skills?agent_uuid=` 让 edge-proxy 拉取
- `creator_skills` DB 表结构对齐 SKILL.yaml frontmatter 字段
- edge-proxy 启动时同步 + 长连接 Pub/Sub 增量更新
- infiniti-agent `.infiniti-agent/skills/` 复用同一接口（可选）

### 9.3 Schema Drift 防御（低价值，但治本）

**目标**：保证 4 个仓库共享的 wire schema（agents、sessions、messages、edge.*）不再人肉维护。

**落点**：
- linkyun-agent 生成 OpenAPI 3.1 spec（go-swag 或手写）
- linkyun-agent-ui 用 `openapi-typescript` 生成 `lib/api.types.ts`
- edge-proxy 用 `oapi-codegen` 生成客户端 stub
- infiniti-agent 同样用 `openapi-typescript`
- CI 强制 spec hash 一致

---

## 10. 速查表

```text
端口
  :8080  linkyun-agent (HTTP)
  :8080  lumina-ai-chat-hub dev (UI)
  :5180  linkyun-app dev (Mobile UI)
  :8081  client-web-ui dev (UI)
  :3306  MySQL
  :6379  Redis
  :8000  Chroma

URL
  https://api.linkyun.co       /api/v1/...
  https://amp.linkyun.co       /messages/inbox/...
  http://localhost:8080        开发期同上

Header
  X-API-Key             Creator 三端
  X-Edge-Token          edge-proxy
  X-Workspace-Code      Workspace 切换
  X-Internal-API-Key    内部脚本
  X-Share-User-Code     分享访客

LLM Provider
  云端：gemini / claude / openai / glm / qwen / doubao / minimax
  边缘：openai / claude / gemini / ollama / deepseek / qwen / doubao /
       moonshot / zhipu / ernie + ollama-openai 兼容

文档维护
  本文件路径：d:\infiniti-agent\docs\LINKYUN_ECOSYSTEM.md
  改动后请同步 d:\infiniti-agent\docs\PROJECT_OVERVIEW.md 中"LinkYun 平台集成"章节
```

---

## 附：本文档的事实来源

每一处声明都可在以下文件验证：

- `@D:\linkyun-agent\cmd\server\main.go`（路由全集）
- `@D:\linkyun-agent\internal\api\handler\edge.go`（Edge 服务端）
- `@D:\linkyun-agent\internal\api\middleware\auth.go`（鉴权）
- `@D:\linkyun-agent\.env.example`（部署变量）
- `@D:\linkyun-agent\README.md`（架构与示例）
- `@D:\edge-proxy\cmd\main.go`（Edge 客户端入口）
- `@D:\edge-proxy\internal\proxy\proxy.go`（Edge 长轮询）
- `@D:\edge-proxy\edge-proxy-config.yaml.example`（Edge 配置）
- `@D:\edge-proxy\summary.md`（Edge 项目总结）
- `@D:\linkyun-agent-ui\client-web-ui\src\lib\api.ts`（Creator UI API）
- `@D:\linkyun-agent-ui\client-user-hub\lumina-ai-chat-hub\services\api.ts`（User UI API）
- `@d:\infiniti-agent\src\cli\linkyunSync.ts`（CLI 同步）
- `@d:\infiniti-agent\src\link.ts`（CLI 邮件桥）
- `@d:\infiniti-agent\package.json`（CLI 包定义）
- `@d:\infiniti-agent\docs\PROJECT_OVERVIEW.md`（CLI 自身文档）
