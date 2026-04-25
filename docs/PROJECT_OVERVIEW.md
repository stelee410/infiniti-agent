# Infiniti Agent — 项目介绍 / 函数调用链 / 使用手册

> 基于源码（`package.json` 0.8.1）梳理。所有模块名与函数名均直接对应仓库内的真实标识，便于读者据此跳转与追溯。

---

## 1. 项目定位

**LinkYun Infiniti Agent**（npm 包 `linkyun-infiniti-agent`，命令 `infiniti-agent`）是一个面向终端的多模型 AI Agent 框架。它把"LLM + 工具 + 记忆 + 多模态外设"打包到一个 Node.js CLI 中，并强调**项目级独立运行**：每个工作目录下的 `.infiniti-agent/` 自带配置、会话、记忆、Skills、错误日志，互不干扰。

提供三类入口：

- **TUI 对话**（默认）：Ink + React 终端界面，流式输出与斜杠命令补全。
- **单轮 CLI**：`infiniti-agent cli <prompt>`，无交互，方便嵌入 shell 循环 / cron / 邮件守护。
- **LiveUI**：在 TUI 之外再开一个 Electron 透明窗（Live2D / PNG sprite + TTS + ASR + 鼠标互动）。

支持的 LLM 厂商：`anthropic`、`openai`、`gemini`、`minimax`、`openrouter`（详见 `@/src/config/types.ts:1`）。

---

## 2. 核心特性概览

- **多 LLM Profile**：`config.json` 中可同时声明多个命名 profile，运行时按用途切换 — `main`（主对话）、`gate`（工具安全评估）、`compact`（会话压缩）。
- **项目级独立空间**：所有持久化数据写入当前目录的 `.infiniti-agent/`，不污染全局；可用 `migrate` 从 `~/.infiniti-agent/` 拷贝。
- **内置工具集 + MCP 扩展**：14 个开箱即用工具，加上任意 stdio MCP 服务器（自动以 `mcp__<server>__<tool>` 命名暴露）。
- **三级工具安全评估**：只读放行 → 规则引擎 → LLM gate profile 兜底，可由用户在被 block 后用自然语言批准。
- **结构化记忆 + 用户画像 + 时序知识图谱**：分别落到 `memory.json`、`user_profile.json`、SQLite 表，由专门工具维护。
- **会话自动压缩 + FTS5 全文检索**：达阈值时归档当前会话到 `sessions.db`，再用 `compact` profile 生成中文摘要替换旧消息；`search_sessions` 工具可全文回查。
- **Skills 可插拔**：`.infiniti-agent/skills/<id>/SKILL.md` 自动注入 system prompt，支持从 `owner/repo` / git URL / 本地路径安装。
- **多模态外设**：TTS（MiniMax / MOSS-TTS-Nano / VoxCPM）、ASR（OpenAI Whisper / sherpa-onnx SenseVoice）、Live2D Cubism Core、PNG 表情精灵。
- **LinkYun 平台集成**：`sync` 拉取 SOUL.md 与角色稿，`generate_avatar` 用 OpenRouter 图像 API 生成半身像 / 表情 / 透明背景，`link` 生成邮件轮询守护脚本。

---

## 3. 系统架构

```text
                    infiniti-agent (Node 20+)
                    src/cli.tsx  (commander)
   ┌─────────────────────────┬─────────────────────────────────┐
   │  init / migrate / upgrade / add_llm / select_llm           │
   │  chat (default) ───────────────►  runChatTui ──► <ChatApp> │
   │  cli <prompt>  ───────────────►  runCliPrompt              │
   │  live          ──► runChatTui + LiveUiSession + Electron   │
   │  link / sync / generate_avatar / set_live_agent / test_asr │
   │  skill install | add | list                                │
   └─────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
   ┌────────────────────────────────────────────────────────────┐
   │  System Prompt 组装  src/prompt/systemBuilder.ts             │
   │   SOUL.md / INFINITI.md  (loadAgentPromptDocs)              │
   │ + IDENTITY + 内置代码质量 + 内置工具与 TUI 边界               │
   │ + 长期记忆 (memory.json)                                     │
   │ + 用户画像 (user_profile.json)                                │
   │ + 已安装 Skills (.infiniti-agent/skills/*/SKILL.md)            │
   │ + memoryNudge                                                │
   └────────────────────────────────────────────────────────────┘
                             │
                             ▼
   ┌────────────────────────────────────────────────────────────┐
   │  核心循环  runToolLoop  src/llm/runLoop.ts                   │
   │   按 provider 分发：runAnthropic / runOpenAI / runGemini       │
   │   流式 SSE，每个 tool_use 块结束立即 dispatch（并行执行）        │
   │   90s 流闲置 watchdog · 180s 整体超时 · MAX_TOOL_STEPS = 48    │
   └────────────────────────────────────────────────────────────┘
                  │                              │
                  ▼                              ▼
   ┌──────────────────────────┐   ┌──────────────────────────────┐
   │ evaluateToolSafety        │   │ runBuiltinTool                │
   │ src/llm/toolGateAgent.ts  │   │ src/tools/runner.ts            │
   │  L0 ALWAYS_SAFE           │   │  read_file / write_file /...   │
   │  L0.5 user-approved       │   │  bash / http_request           │
   │  L1 rule engine           │   │  memory / user_profile / kg    │
   │  L2 LLM gate profile      │   │  search_sessions / manage_skill│
   └──────────────────────────┘   │ McpManager.call                │
                                  │  src/mcp/manager.ts            │
                                  │  mcp__<server>__<tool>         │
                                  └──────────────────────────────┘
                             │
                             ▼
   ┌────────────────────────────────────────────────────────────┐
   │  持久化层  .infiniti-agent/                                   │
   │   session.json  ──► loadSession / saveSession (file.ts)       │
   │   sessions.db   ──► archiveSession / searchSessions (FTS5)    │
   │   memory.json / user_profile.json (结构化条目)                 │
   │   memory.md     (旧版自由文本，update_memory 已弃用)            │
   │   skills/*      ref/<agent>/  error.log                       │
   └────────────────────────────────────────────────────────────┘

        LiveUI 数据流（infiniti-agent live）:
        Node ──WebSocket──► Electron 渲染端（liveui 子包，Live2D Cubism Core）
            ASSISTANT_STREAM / ACTION / AUDIO_CHUNK / STATUS_PILL / SLASH_COMPLETION
            ◄── USER_INPUT / USER_COMPOSER / INTERRUPT / MIC_AUDIO / LIVEUI_INTERACTION
```

---

## 4. 目录与数据布局

```text
your-project/
├── .infiniti-agent/                  # 项目级独立空间
│   ├── config.json                   # 优先级高于 ~/.infiniti-agent/config.json
│   ├── session.json                  # 当前会话（loadSession / saveSession）
│   ├── sessions.db                   # 历史会话归档 + FTS5 全文索引
│   ├── memory.json                   # 结构化长期记忆（最多 6000 字）
│   ├── memory.md                     # 旧版自由文本记忆（update_memory，已弃用）
│   ├── user_profile.json             # 用户画像（tech_stack/communication/...）
│   ├── skills/<id>/SKILL.md          # 已安装 Skill
│   ├── ref/<agent_code>/             # linkyun sync 拉取的资源
│   └── error.log                     # CLI / TUI 错误流水
├── SOUL.md                           # 人格定义（也兼容 AGENTS.md / AGENT.md）
├── INFINITI.md                       # 项目指令（也兼容 CLAUDE.md / .claude/CLAUDE.md）
├── live2d-models/                    # Live2D 模型资源（与 Open-LLM-VTuber 对齐）
└── model_dict.json                   # Live2D 模型清单
```

包内常驻：

- `src/`：TypeScript 源码（`tsc` 输出到 `dist/`）。
- `liveui/`：独立的 Vite/React 子包（`npm run build` 时由 workspace 一并构建）。
- `scripts/`：TTS/ASR 模型下载、liveUi 配置合并等辅助脚本。

---

## 5. CLI 命令一览

来源：`@/src/cli.tsx:225`。

| 命令 | 用途 |
|---|---|
| `infiniti-agent` / `chat` | 进入 TUI 对话（无参数时默认） |
| `cli <prompt...>` | 单轮非交互执行，结果流到 stdout |
| `init` | 交互式向导，写入**全局** `~/.infiniti-agent/config.json` |
| `migrate` | 复制全局配置 / memory / skills 到当前目录 `.infiniti-agent/` |
| `upgrade [--global]` | 升级旧 config 格式（平铺 llm → profiles，移除废弃字段） |
| `add_llm [--profile <name>] [--provider <p>]` | 拉取模型列表，向项目 config 添加 LLM profile |
| `select_llm [--name <profile>]` | 切换 `llm.default` |
| `live [-p <port>] [--zoom <0.4-1.5>]` | TUI + WebSocket + Electron 透明窗 |
| `test_asr [--rms <n>] [--silence-ms <n>] [--min-chunk-ms <n>]` | ffmpeg 采集 → 静音切段 → 调 ASR 验证 |
| `link` | 从 `SOUL.md` 提取邮件配置，生成 `mail-poller.sh` |
| `sync [--api-base <url>] [--workspace <code>]` | 登录 LinkYun 选 Agent，写入 SOUL.md + 拉取头像/角色稿 |
| `generate_avatar --agent <code> [--out <dir>] [--skip-half-body] [--no-transparentize]` | 用 OpenRouter 图像 API 生成半身像 + 8 个表情 PNG，并对边缘连通背景做透明 |
| `set_live_agent <code>` | 写入 `liveUi.spriteExpressions.dir`，把 LiveUI 形象切到指定 agent |
| `skill install \| add <source>` | 安装 Skill（`owner/repo` / git URL / 本地路径） |
| `skill list` | 列出已安装 Skills |

全局选项：

- `--debug` — 打开 `agentDebug` 详细日志（meta-agent / 工具调度等到 stderr）。
- `--dangerously-skip-permissions` — 跳过所有工具安全评估，直接执行。
- `--disable-thinking` — 禁用 Anthropic 的 extended thinking。

---

## 6. TUI 斜杠命令

来源：`@/src/ui/slashCompletions.ts:16` 与 `@/src/ui/ChatApp.tsx`。

| 命令 | 行为 |
|---|---|
| `/exit` `/quit` | 保存会话并退出 |
| `/new` `/clear` | 归档当前会话到 `sessions.db` 并清空内存 |
| `/reload` `/reload-skills` | 重读 `config.json` + 重启 MCP + 重载 Skills |
| `/memory` | 提示记忆文件位置（`.infiniti-agent/memory.json` 与 `user_profile.json`） |
| `/help` | 列出所有斜杠命令 |
| `/speak <text>` | 仅在 `live` 模式下用 TTS 朗读，**不写入会话**（用于音色测试） |
| `/undo` | 弹栈式撤销最近一次 `write_file` / `str_replace`（`EditHistory`） |
| `/permission` | 显示当前权限模式（meta-agent 自动 vs 全部跳过） |
| `/compact [自定义指令]` | 立即触发会话压缩，可附加给 compact profile 的额外说明 |

输入框以 `/` 开头且无空格时，会进入补全菜单（↑↓ 选择，Tab 写入），同时会列出全部内置工具与 MCP 工具名（`buildSlashItems`）。

---

## 7. 内置工具一览

来源：`@/src/tools/definitions.ts` 中的 `BUILTIN_TOOLS` 与 `@/src/tools/runner.ts:runBuiltinTool`。

### 7.1 文件类（受 sessionCwd 限制）

- `read_file`：按路径读取，可指定 `start_line` / `end_line` 分片。
- `list_directory`：列出某目录的直接子项（名称 + 类型）。
- `glob_files`：fast-glob 模式枚举（默认忽略 `node_modules` / `.git` / `dist`）。
- `grep_files`：跨文件正则搜索，按文件聚合。
- `write_file`：覆盖写入；通过 `EditHistory` 记录快照供 `/undo`。
- `str_replace`：精确字符串替换；同样进入 `EditHistory`。

### 7.2 系统类

- `bash`：执行 shell 命令；Windows 下用 `powershell.exe -NoProfile -NonInteractive -Command`，Unix 用 `bash -lc`；返回 `{ok, code, stdout, stderr}`。
- `http_request`：原生 `fetch`，支持 method/url/headers/body/timeoutMs。

### 7.3 记忆类

- `memory`：结构化条目 CRUD（`add` / `replace` / `remove` / `list`），写入 `.infiniti-agent/memory.json`，总容量上限 **6000 字**，标签集合 `fact|preference|lesson|convention|environment|other`。
- `user_profile`：用户画像 CRUD，写入 `user_profile.json`，标签 `tech_stack|communication|workflow|background|other`。
- `knowledge_graph`：时序三元组（subject / predicate / object + valid_from / ended），动作 `add` / `invalidate` / `query` / `timeline` / `stats`。
- `search_sessions`：在 `sessions.db` 的 `session_messages_fts` 上做 FTS5 全文搜索，返回片段 + 时间。
- `update_memory`：旧版 append-only 写入 `memory.md`，**已弃用**，新代码请用 `memory`。

### 7.4 元类

- `manage_skill`：自创建 / 局部更新 / 删除 `.infiniti-agent/skills/<name>/SKILL.md`，便于"做完一类任务后总结成 Skill"。

### 7.5 MCP 工具

`McpManager` 启动 `config.mcp.servers` 中每个 stdio 服务器，把每个工具暴露为 `mcp__<server_key>__<tool_name>`（自动 sanitize、截断到 64 字符）。调用走 `client.callTool`，返回 `out.content` 序列化字符串（>200KB 截断）。

---

## 8. 工具安全评估（Meta-Agent）

`runToolLoop.dispatch` 在执行每个工具前调用 `evaluateToolSafety`（`@/src/llm/toolGateAgent.ts:153`）。流程：

```text
                        ┌────────────────────┐
                        │  toolName + detail │
                        │  + recent messages │
                        └─────────┬──────────┘
                                  │
                ┌─────────────────┴────────────────┐
                ▼                                   ▼
  L0  ALWAYS_SAFE 集合命中                 否
      (read_file / list_directory /        │
       grep_files / glob_files /           ▼
       file_info / search_files /     ┌────────────────────────┐
       read_notebook_cell)            │ L0.5 用户在前轮 block   │
        ──► approve                   │ 后明确批准              │
                                      │ (确定/可以/yes/ok/...)  │
                                      └─────────┬──────────────┘
                                                │ 是 ──► approve
                                                │ 否
                                                ▼
                                      ┌──────────────────────────┐
                                      │ L1 规则引擎 evaluateByRules │
                                      │  bash 危险正则 → ask         │
                                      │  bash 安全正则 → approve     │
                                      │  bash + EXEC intent → approve│
                                      │  http GET / HTTP intent     │
                                      │  write_file/str_replace +    │
                                      │   EDIT intent → approve      │
                                      │  其他 MCP 工具 → approve     │
                                      └─────────┬────────────────┘
                                                │ 命中 ──► 返回
                                                │ 未命中
                                                ▼
                                      ┌──────────────────────────┐
                                      │ L2  llmEvaluate           │
                                      │  oneShotTextCompletion     │
                                      │   profile = 'gate'         │
                                      │  系统提示要求只回 JSON     │
                                      │   {decision, reason}       │
                                      │  解析失败时默认 approve    │
                                      └──────────────────────────┘
```

返回 `ask` / `deny` 时，dispatch 不执行工具，而是把 `{status: 'blocked', reason, instruction}` 作为 tool_result 回写，让 LLM 在下一轮向用户解释或申请确认。

---

## 9. 关键函数调用链

### 9.1 单轮 CLI （`infiniti-agent cli <prompt>`）

```text
src/cli.tsx:main
  └─► runCliPrompt(cfg, prompt)                       (src/runCliPrompt.ts:37)
        ├─► McpManager.start(cfg)                      (src/mcp/manager.ts:36)
        ├─► loadSession(cwd)                            (src/session/file.ts:8)
        ├─► estimateMessagesTokens(messages)            (src/llm/estimateTokens.ts)
        │     └─[超阈值]
        │         ├─► archiveSession(cwd, messages)     (src/session/archive.ts:79)
        │         └─► compactSessionMessages({...})     (src/llm/compactSession.ts:168)
        ├─► buildSystemWithMemory(cfg, cwd)             (src/prompt/systemBuilder.ts:8)
        │     ├─► loadAgentPromptDocs(cwd)
        │     ├─► loadMemoryStore(cwd)  / loadProfileStore(cwd)
        │     ├─► loadSkillsForCwd(cwd)
        │     └─► buildAgentSystemPrompt + memoryNudge
        ├─► runToolLoop({ config, system, messages, cwd, mcp, editHistory, stream })
        │     (src/llm/runLoop.ts:70)
        │     └─► resolveLlmProfile  → runAnthropic / runOpenAI / runGemini
        │           └─► dispatch(name, argsJson)        (runLoop.ts:86)
        │                 ├─► evaluateToolSafety        (src/llm/toolGateAgent.ts:153)
        │                 ├─► runBuiltinTool            (src/tools/runner.ts)
        │                 └─► McpManager.call           (src/mcp/manager.ts:133)
        ├─► saveSession(cwd, out)                       (src/session/file.ts:26)
        └─► McpManager.stop  + process.exit
```

### 9.2 TUI 多轮（`infiniti-agent` 默认 / `chat`）

```text
src/cli.tsx:runChatTui
  ├─► McpManager.start(cfg)
  ├─► render(<ChatWithSplash config mcp ...>)        (src/ui/ChatWithSplash.tsx)
  │     └─► <ChatApp>                                  (src/ui/ChatApp.tsx)
  │           ├─► loadSession(cwd) → setMessages
  │           ├─► chokidar 监听 SOUL.md / INFINITI.md / skills 变更 → setPromptEpoch
  │           ├─► 用户输入 → 解析斜杠命令分支
  │           │     /clear  → archiveSession + setMessages([])
  │           │     /compact → compactSessionMessages({...})
  │           │     /reload → loadConfig + mcp.stop+start + setSkillsEpoch
  │           │     /undo  → restoreEditSnapshot(EditHistory)
  │           │     /speak (live) → liveUi.resetAudio + enqueueTts
  │           │     ……
  │           └─► 否则 runToolLoop({stream: { onTextDelta, onToolUseStart, onToolExecStart, onThinkingDelta }})
  │                 → 句末切段后 enqueueTts（live）
  │                 → 写入 setStreamText / setMessages → saveSession
  └─► exit 时 mcp.stop + liveUi.dispose
```

### 9.3 LiveUI（`infiniti-agent live`）

```text
src/cli.tsx:live action
  ├─► resolveSpriteExpressionDirForUi / resolveLive2dModelForUi
  ├─► new LiveUiSession(port)                          (src/liveui/wsSession.ts:28)
  └─► runChatTui({ liveUi, liveUiModel3FileUrl, liveUiSpriteExpressionDirFileUrl, liveUiVoiceMicJson, liveUiFigureZoom })
        ├─► liveUi.start()  → WebSocketServer.listen
        ├─► liveUi.startMouthPump() → 30Hz SYNC_PARAM(ParamMouthOpenY)
        ├─► liveUi.setTtsEngine(createMinimaxTts | createMossTtsNano | createVoxcpmTts)
        ├─► liveUi.setAsrEngine(createWhisperAsr | createSherpaOnnxAsr)
        ├─► spawnLiveElectron(port, {model3FileUrl, spriteExpressionDirFileUrl, voiceMicJson, figureZoom})
        │     (src/liveui/spawnRenderer.ts)
        │     → 子进程 electron liveui/electron-main.cjs
        │     → 窗口加载 liveui/dist/index.html 与 ws://127.0.0.1:<port>
        └─► <ChatApp liveUi=...>
              ├─► assistant 流式 → processAssistantStreamChunk 解析 [Happy] 等
              │     → liveUi.sendAssistantStream / sendAction
              │     → 句末 → liveUi.enqueueTts → AUDIO_CHUNK
              └─► 渲染端事件回流到 LiveUiSession：
                    USER_INPUT      → emitUserLine     → ChatApp 当作输入处理
                    USER_COMPOSER   → emitUserComposer → 同步 SLASH_COMPLETION
                    INTERRUPT       → emitInterrupt    → 中断当前 runToolLoop
                    MIC_AUDIO       → handleMicAudio   → ASR → ASR_RESULT
                    LIVEUI_INTERACTION (head_pat / body_poke)
                                    → emitInteraction  → 合成一条用户消息
```

### 9.4 工具调度 + 安全评估

```text
runToolLoop 内的 dispatch(name, argsJson):
  ├─[skipPermissions=false]
  │   ├─► CONFIRMABLE_BUILTIN_TOOLS 命中？
  │   │     ├─是 → formatToolConfirmDetail(name, args, cwd)
  │   │     └─否 → `${name}(${argsJson 截断})` 作为 detail
  │   ├─► evaluateToolSafety(cfg, name, detail, messages)
  │   │     ├─ L0 ALWAYS_SAFE → approve
  │   │     ├─ L0.5 userApprovedAfterBlock → approve
  │   │     ├─ L1 evaluateByRules → approve / ask / null
  │   │     └─ L2 llmEvaluate (oneShotTextCompletion profile='gate')
  │   ├─ deny → 返回 {status:'blocked', denied:true, reason}
  │   └─ ask  → 返回 {status:'blocked', reason, detail, instruction}
  └─[approve]
      ├─ builtin.has(name) → runBuiltinTool(name, argsJson, {sessionCwd, editHistory})
      └─ 否则 → McpManager.call(name, argsJson)
```

### 9.5 自动会话压缩

```text
estimateMessagesTokens(messages) >= compaction.autoThresholdTokens
  └─► archiveSession(cwd, messages)            // SQLite + FTS5 入库（含触发器同步）
  └─► compactSessionMessages({config, cwd, messages, minTailMessages, maxToolSnippetChars, preCompactHook})
        ├─► findSafeCompactSplitIndex      // 保证后缀以合法消息开头、tool 链完整
        ├─► messagesToCompactTranscript + truncateTranscriptAtBoundary (≤400_000 chars)
        ├─► [可选] runPreCompactHookExec(hookPath, cwd, transcript)   // 15s 超时
        └─► oneShotTextCompletion({system: COMPACT_SUMMARY_SYSTEM, user: transcript, profile: 'compact', maxOutTokens:8192})
              → 中文摘要（≤24_000 chars）
        ← 返回 [{role:'user', content: '## [会话压缩摘要]\n\n' + summary + tail[0]?}, ...tail.slice(1)]
  └─► saveSession(cwd, newMessages)
```

---

## 10. System Prompt 组装顺序

`buildSystemWithMemory(cfg, cwd)` 拼接的实际顺序（`@/src/prompt/systemBuilder.ts:8`）：

1. `IDENTITY_SECTION` — Infiniti Agent 身份与文件命名约定。
2. `formatSystemFromDocs(docs)` — `SOUL.md` + `INFINITI.md`（按 fallback 链查找）。
3. `BUILTIN_CODE_QUALITY_SECTION` — 内置代码质量约束。
4. `BUILTIN_TOOL_AND_BOUNDARIES_SECTION` — 内置工具与 TUI 边界。
5. `memoryToPromptBlock(memStore)` — 结构化长期记忆（含容量百分比）。
6. `profileToPromptBlock(profileStore)` — 用户画像。
7. `skillsToSystemBlock(skills)` — 已安装 Skills 的 SKILL.md 拼接。
8. `MEMORY_NUDGE_SECTION` — 提醒模型主动写记忆。

SOUL 与 INFINITI 的 fallback 链（`@/src/prompt/loadProjectPrompt.ts:29`）：

- `SOUL.md` → `cwd/SOUL.md` → `cwd/AGENTS.md` → `cwd/AGENT.md` → 包内 `SOUL.md` → 内置 `FALLBACK_SOUL`。
- `INFINITI.md` → `cwd/INFINITI.md` → `cwd/CLAUDE.md` → `cwd/.claude/CLAUDE.md` → 包内 `INFINITI.md` → 空。

---

## 11. 配置文件 schema 摘要

实际 schema 见 `@/src/config/types.ts` 与 `@/src/config/io.ts`。最小可用：

```json
{
  "version": 1,
  "llm": {
    "default": "main",
    "profiles": {
      "main":    { "provider": "anthropic", "baseUrl": "https://api.anthropic.com",                "model": "claude-sonnet-4-20250514", "apiKey": "sk-..." },
      "gate":    { "provider": "gemini",    "baseUrl": "https://generativelanguage.googleapis.com/v1beta", "model": "gemini-2.0-flash",         "apiKey": "AIza..." },
      "compact": { "provider": "openai",    "baseUrl": "https://api.openai.com/v1",               "model": "gpt-4.1-mini",             "apiKey": "sk-..." }
    },
    "provider": "anthropic", "baseUrl": "https://api.anthropic.com", "model": "claude-sonnet-4-20250514", "apiKey": "sk-..."
  }
}
```

可选块：

- `mcp.servers`：`{ <id>: { command, args?, env?, cwd? } }` — stdio MCP 服务器。
- `compaction`：`autoThresholdTokens` / `minTailMessages` / `maxToolSnippetChars` / `preCompactHook`。
- `thinking`：`{ mode: 'adaptive' | 'enabled' | 'disabled', budgetTokens? }`（仅 Anthropic 生效）。
- `liveUi`：端口、Live2D 模型清单 / 直链、麦克 RMS 阈值、PNG sprite 目录等。
- `tts`：`provider` 为 `minimax` / `moss_tts_nano` / `voxcpm` 之一，配套字段见 `parseTtsConfig`。
- `asr`：`provider` 为 `whisper`（apiKey + baseUrl + model + lang）或 `sherpa_onnx`（onnx + tokens + lang + numThreads）。
- `avatarGen`：OpenRouter 兼容图像 API（`generate_avatar` 使用），默认模型 `google/gemini-3-pro-image-preview`。

兼容性：`loadConfig` 同时接受旧的"平铺 llm"格式；`infiniti-agent upgrade` 会把它迁移成 `profiles`。

---

## 12. 使用手册

### 12.1 首次安装与配置

```bash
npm install -g linkyun-infiniti-agent

# 全局向导：写到 ~/.infiniti-agent/config.json
infiniti-agent init

# 进入项目目录，把全局配置克隆为项目级
cd your-project
infiniti-agent migrate

# 可选：再加几个 profile
infiniti-agent add_llm --profile gate    --provider gemini
infiniti-agent add_llm --profile compact --provider openai
infiniti-agent select_llm --name main
```

### 12.2 日常对话

```bash
infiniti-agent                       # TUI（默认 chat）
infiniti-agent cli "把 README 翻成英文"   # 单轮
infiniti-agent cli 部署一下 --debug     # 详细日志到 stderr
infiniti-agent --dangerously-skip-permissions   # 跳过所有工具确认
infiniti-agent --disable-thinking       # 关闭 Anthropic extended thinking
```

TUI 内常用：`/help` 查看命令列表；`/clear` 归档并新开会话；`/compact` 手动压缩；`/undo` 回滚最近一次写入。

### 12.3 LiveUI 桌面伴侣

```bash
# 已 build 过 liveui 子包后
infiniti-agent live                  # 默认端口 8080 / config.liveUi.port
infiniti-agent live -p 9000 --zoom 0.9
INFINITI_LIVEUI_DEBUG_WINDOW=1 infiniti-agent live   # 显示标题栏 / 视图菜单
INFINITI_LIVEUI_DEVTOOLS=1 infiniti-agent live       # 自动打开 DevTools
```

`liveUi.spriteExpressions.dir` 设置且路径有效时，仅用 PNG 切换表情，不再加载 Live2D 模型。模型清单格式与 [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber) 的 `model_dict.json` 对齐。

`infiniti-agent test_asr` 可单独测试麦克风 RMS 阈值与静音切段，便于校准 `liveUi.voiceMicSpeechRmsThreshold`、`voiceMicSilenceEndMs`。

### 12.4 邮件守护（link）

`SOUL.md` 中需出现：

- agent 地址 `xxx@xxx.amp.linkyun.co`
- agent ID（UUID）
- API Key（`amk_...`）

```bash
infiniti-agent link                  # 生成 mail-poller.sh
./mail-poller.sh                     # 前台
nohup ./mail-poller.sh &             # 后台
./mail-poller.sh --once              # 单次
```

脚本每 60 秒查 LinkYun Mail Broker 收件箱，发现未读邮件时调用 `infiniti-agent cli` 处理；日志写到 `mail-poller.log`。

### 12.5 LinkYun 平台同步

```bash
infiniti-agent sync                  # 登录 → 选 Agent → 写 SOUL.md → 拉取 ref/<code>/
infiniti-agent generate_avatar --agent jess
infiniti-agent set_live_agent jess   # 把 LiveUI 形象切到 jess
```

`generate_avatar` 默认走 Nano Banana Pro（`google/gemini-3-pro-image-preview`），可通过 `avatarGen.model` 或 `INFINITI_AVATAR_GEN_MODEL` 覆盖。最后会调用 `transparentizePngBackground` 对 `half_body.png` 与各表情做"边缘连通背景"透明化。

### 12.6 Skills 安装与管理

```bash
infiniti-agent skill add owner/repo                     # GitHub
infiniti-agent skill add https://gitlab.com/x/y.git     # 任意 git URL
infiniti-agent skill add ./local/path                   # 本地目录
infiniti-agent skill list
```

仓库根需有 `SKILL.md`，否则会以警告形式安装但不会被加载（`loadSkillsForCwd` 仅扫描含 `SKILL.md` 的子目录）。也可以让 agent 自己用 `manage_skill` 工具创建。

### 12.7 MCP 服务器接入

在 `.infiniti-agent/config.json` 中追加：

```json
{
  "mcp": {
    "servers": {
      "fs": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
      },
      "qmd": {
        "command": "node",
        "args": ["/path/to/qmd-mcp/dist/index.js"],
        "env": { "QMD_INDEX": "/path/to/index" }
      }
    }
  }
}
```

启动时 `McpManager.start` 会 `client.listTools()` 并把工具暴露为 `mcp__fs__read_file` / `mcp__qmd__query` 之类的全名；`/reload` 可重新连接。

### 12.8 调试与故障排查

- 加 `--debug` 后，`agentDebug` 打印所有 stream 事件、工具分发、meta-agent 决策到 stderr。
- 错误日志统一写到 `.infiniti-agent/error.log`（`runCliPrompt` 会附完整 stack）。
- LLM 长时间无响应：`runLoop.ts` 内置 180s 整体超时 + 90s SSE 闲置 watchdog；超时后会抛出可读错误（含网络/baseUrl/key 排查提示）。
- 工具被 block 后再继续：用户在下一条直接说"可以"/"yes"/"go ahead" 即可放行（`userApprovedAfterBlock`）。
- LiveUI 看不到窗口：可能是 optional 依赖 `electron` 未拉到；进入包安装目录跑一次 `npm install`，或加 `INFINITI_LIVEUI_DEBUG_WINDOW=1` 看是否启动了。

### 12.9 本地 TTS 服务（VoxCPM）

VoxCPM 是 `tts.provider = "voxcpm"` 时使用的本地 TTS 服务，需要先单独把 venv + 模型 + HTTP 服务跑起来。所有脚本提供 `.sh`（macOS / Linux）与 `.py`（Windows 11）两个等价版本，行为完全一致。

#### macOS / Linux

```bash
bash scripts/setup-voxcpm-venv.sh        # 在 third_party/voxcpm-venv 建独立 venv + pip install
bash scripts/download-voxcpm-model.sh    # 下载 openbmb/VoxCPM2 到 models/VoxCPM2
bash scripts/start-voxcpm-tts-serve.sh   # 启动 HTTP 服务（默认 127.0.0.1:8810）
```

#### Windows 11（PowerShell）

```powershell
python scripts\setup-voxcpm-venv.py        # 同上
python scripts\download-voxcpm-model.py    # 同上
python scripts\start-voxcpm-tts-serve.py   # 同上
```

要求 Python 3.10～3.12（VoxCPM 文档限制 <3.13）。脚本按以下顺序探测解释器：`VOXCPM_PYTHON` → `python3.12 / 3.11 / 3.10` → `python3` / `python` → Windows `py -3.x` launcher。

Windows 11 上若检测到 NVIDIA GPU（`nvidia-smi` 可执行），`setup-voxcpm-venv.py` 会先从 `https://download.pytorch.org/whl/cu126` 安装 CUDA 版 `torch / torchaudio`，再装其他依赖。否则装 CPU 版（macOS / Linux 行为不变）。这是为绕开 PyPI 默认 cpu-only torch 在 Windows 上触发 VoxCPM `scaled_dot_product_attention` 维度错误的已知问题。

`setup-voxcpm-venv.py` 完成 venv 与 pip install 后会自动调用 `download-voxcpm-model.py`；不希望自动下载（如已离线缓存好模型）请设 `VOXCPM_SKIP_MODEL_DOWNLOAD=1`。

#### 关键环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `VOXCPM_VENV` | `<repo>/third_party/voxcpm-venv` | venv 安装目录 |
| `VOXCPM_PYTHON` | 自动探测 | 强制指定 Python 解释器 |
| `VOXCPM_HF_REPO` | `openbmb/VoxCPM2` | HuggingFace 仓库 |
| `VOXCPM_MODEL_DIR` | `<repo>/models/VoxCPM2` | 模型本地目录 |
| `VOXCPM_MODEL_ID` | 自动指向本地目录 | 启动服务时使用的 model id（HF ID 或绝对路径） |
| `SSL_CERT_FILE` | `certifi.where()` 兜底 | CA 证书（内网 https 报错时手动指定） |

#### 集成到 `infiniti-agent`

服务起来后，在 `.infiniti-agent/config.json` 设：

```json
{
  "tts": {
    "provider": "voxcpm",
    "baseUrl": "http://127.0.0.1:8810"
  }
}
```

完整字段以 `parseTtsConfig` 解析为准（`@/src/config/types.ts`）。

#### 开发者：跑脚本单元测试

`scripts/_winutils.py` 集中了 venv 路径 / Python 探测 / pip install 等共享逻辑，配套 4 个测试文件覆盖纯函数与模块加载（共 30 用例，含自动下载与 GPU 检测断言）：

```powershell
python scripts\_winutils_test.py
python scripts\setup-voxcpm-venv_test.py
python scripts\download-voxcpm-model_test.py
python scripts\start-voxcpm-tts-serve_test.py
```

### 12.10 本地 TTS 服务（MOSS-TTS-Nano）

MOSS-TTS-Nano 是 `tts.provider = "moss_tts_nano"` 时使用的本地 TTS 服务，**走 ONNX runtime CPU 推理**（不需要 GPU；首句较慢但无显存压力）。所有脚本同样提供 `.sh`（macOS / Linux）与 `.py`（Windows 11）两个等价版本。

#### macOS / Linux

```bash
bash scripts/setup-moss-tts-onnx-venv.sh    # 克隆 MOSS-TTS-Nano + 应用 patch + 建 venv + pip install
bash scripts/download-moss-onnx-models.sh   # 下载 2 个 ONNX 仓库 + zh_1.wav 参考音
bash scripts/start-moss-tts-onnx.sh         # 启动 HTTP 服务（默认 127.0.0.1:18083）
```

#### Windows 11（PowerShell）

```powershell
python scripts\setup-moss-tts-onnx-venv.py    # 同上
python scripts\download-moss-onnx-models.py   # 同上
python scripts\start-moss-tts-onnx.py         # 同上
```

要求 **Python 严格 3.11**（MOSS 上游限定）。Windows 上 `setup-moss-tts-onnx-venv.py` 用嵌入式块替换的方式应用 `scripts/patches/moss-onnx-skip-wetext.patch`（Windows 默认无 `patch` 命令），通过 `MOSS_TTS_SKIP_WETEXT` marker 实现幂等检测；`download-moss-onnx-models.py` 用 `tempfile.mkdtemp()` 替代 `/tmp/ia-moss-dl-$$`，用 `urllib.request.urlretrieve` 替代 `curl`。

#### 关键环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `MOSS_TTS_NANO_HOME` | `<repo>/third_party/MOSS-TTS-Nano` | MOSS 源码目录（venv 嵌在 `.venv/` 子目录） |
| `MOSS_PYTHON` | 自动探测 3.11 | 强制指定 Python 解释器 |
| `MOSS_ONNX_MODEL_DIR` | `<repo>/models` | ONNX 模型根目录 |
| `MOSS_TTS_PORT` | `18083` | 服务端口 |
| `MOSS_TTS_SKIP_WETEXT` | `1` | 跳过 WeTextProcessing（避免 OpenFst 依赖） |
| `SSL_CERT_FILE` | `certifi.where()` 兜底 | CA 证书 |

#### 集成到 `infiniti-agent`

`moss_tts_nano` 必需 `promptAudioPath` 或 `demoId` 之一（声音克隆来源）：

```json
{
  "tts": {
    "provider": "moss_tts_nano",
    "baseUrl": "http://127.0.0.1:18083",
    "promptAudioPath": "D:\\infiniti-agent\\models\\moss-prompt\\zh_1.wav"
  }
}
```

#### 与 VoxCPM 的差异

| 维度 | VoxCPM | MOSS-TTS-Nano |
|---|---|---|
| Python | 3.10–3.12 | **严格 3.11** |
| 推理 | CUDA GPU（自动检测） | **CPU ONNX runtime** |
| 首句延迟 | ~9 s（GPU） | 数十秒（CPU） |
| patch | 无 | 有（嵌入式块替换） |
| venv | `third_party/voxcpm-venv/` | `third_party/MOSS-TTS-Nano/.venv/` |
| 端口 | 8810 | 18083 |

每个 provider 独立 venv 是 **故意的依赖隔离**（VoxCPM 要 `torch>=2.5`、MOSS 要 `torch==2.7.0` 严格版本，互不兼容）。

#### 开发者：跑脚本单元测试

3 个测试文件，共 23 用例（含 patch 块替换与 marker 检测断言）：

```powershell
python scripts\setup-moss-tts-onnx-venv_test.py
python scripts\download-moss-onnx-models_test.py
python scripts\start-moss-tts-onnx_test.py
```

---

## 13. 设计要点 / 已知限制

- **流式工具执行**：Anthropic 路径在 `content_block_stop` 时立即派发工具，不等 `finalMessage`；多个工具并行执行，显著降低长链路延迟。OpenAI / Gemini 路径仍是收齐 tool_calls 后串行 dispatch。
- **`MAX_TOOL_STEPS = 48`**：单次请求里最多 48 轮模型↔工具往返，超过即终止（`runLoop.ts:20`）。
- **Token 估算粗糙**：`estimateMessagesTokens` 仅基于 `messages`，未把 `system` 段（含 SOUL / Skills / 记忆）计入；`docs/TODO.md` 已记录改进项。
- **memory.json 6000 字硬上限**：超出会拒绝写入，需要先 `replace` 或 `remove`；这是为了控制 system prompt 体积。
- **LiveUI 仅本地**：WebSocket 绑定 `127.0.0.1`，未加鉴权，不要把端口暴露到公网。
- **Windows bash 工具**：实际走 PowerShell，部分常见 Linux 命令不可直接套用。
- **MCP 工具名长度上限 64**：超长会被裁剪，可能与原工具名失配。

更多待办与改进项见 `@/docs/TODO.md`。

---

## 14. `src/` 模块详解

> 按目录分组；每个模块给出：**职责一句话** + **关键文件清单**（含字节数，便于判断核心程度）。文件大小取自 `package.json` 0.8.1 快照。

### 14.1 顶层入口（`src/*.ts*`）

| 文件 | 大小 | 作用 |
|---|---|---|
| `cli.tsx` | 22.5 KB | **CLI 主入口**：commander 注册 14 个命令 + `skill` 子命令组；分派到 `runChatTui` / `runCliPrompt` / `runLinkyunSync` 等；解析全局选项 `--debug` / `--dangerously-skip-permissions` / `--disable-thinking` |
| `runCliPrompt.ts` | 4.1 KB | `infiniti-agent cli <prompt>` 单轮非交互入口：MCP 启动 → 加载会话 → token 估算 → 自动压缩 → 系统提示装配 → `runToolLoop` → 保存会话 |
| `link.ts` | 7.9 KB | `link` 命令：从 `SOUL.md` 解析 `*@*.amp.linkyun.co` 邮箱 + UUID + `amk_...` API Key，生成 `mail-poller.sh`（每 60s 轮询 amp.linkyun.co 收件箱） |
| `paths.ts` | 1.9 KB | 全部路径常量与解析函数：`GLOBAL_AGENT_DIR` / `localAgentDir` / `localSessionPath` / `localMemoryJsonPath` / `localLinkyunRefDir` 等；所有持久化路径的"单一来源" |
| `packageRoot.ts` | 0.5 KB | 定位 npm 包根（用于读包内兜底 `SOUL.md` / `INFINITI.md`），同时支持 `dist/` 与 `tsx` 直跑 |

### 14.2 `cli/` — 子命令具体实现（7 个文件）

| 文件 | 大小 | 命令 | 作用 |
|---|---|---|---|
| `linkyunSync.ts` | 11.5 KB | `sync` | **唯一直接调 `api.linkyun.co`**：`POST /api/v1/auth/login` → `GET /api/v1/agents` → 选择 → 写 `SOUL.md` + 拉头像/角色稿到 `.infiniti-agent/ref/<code>/`；`X-API-Key + X-Workspace-Code` 认证 |
| `generateAvatar.ts` | 11.3 KB | `generate_avatar` | 用 OpenRouter `google/gemini-3-pro-image-preview` 生成半身像 + 8 表情 PNG，再调 `transparentizePngBackground` 做边缘连通透明 |
| `testAsr.ts` | 9.0 KB | `test_asr` | ffmpeg 采集 → RMS 静音切段 → 调 ASR 验证；用于校准 `voiceMicSpeechRmsThreshold` 与 `voiceMicSilenceEndMs` |
| `llmCli.ts` | 8.2 KB | `add_llm` / `select_llm` | 交互向导：选 provider → 输 baseUrl/key → 拉模型列表 → 写入 `config.llm.profiles` |
| `llmModelFetch.ts` | 4.6 KB | （`add_llm` 子工具） | 按 provider 调对应 `/v1/models` 拉清单（OpenAI 风格 / Gemini / Anthropic / minimax） |
| `setLiveAgent.ts` | 2.2 KB | `set_live_agent` | 把 `liveUi.spriteExpressions.dir` 写入项目 `config.json`，绑定 LiveUI 形象 |
| `setLiveAgent.test.ts` | 1.3 KB | — | `applySetLiveAgentToConfig` 单测 |

> ⚠️ **注意**：14 个 CLI 命令里只有 `sync` 一个直接调 LinkYun 后端；`generate_avatar` 走 OpenRouter；`add_llm`/`select_llm` 走 LLM 厂商；`link` 不联网（生成本地脚本）。

### 14.3 `ui/` — Ink + React 终端 UI（6 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `ChatApp.tsx` | **31.0 KB** | **TUI 核心**：管理 `messages` / `streamText` / `streamThinking` / `editHistory`；chokidar 监听 `SOUL.md`/`INFINITI.md`/`skills/` 变更；分派 9 个斜杠命令分支；调用 `runToolLoop` 并消费流式回调；与 `LiveUiSession` 双向交互 |
| `InitWizard.tsx` | 7.9 KB | `infiniti-agent init` 的交互向导：选 provider → 输 key → 探活 → 写全局 `~/.infiniti-agent/config.json` |
| `slashCompletions.ts` | 3.7 KB | `/` 开头的命令补全菜单：列出 9 个内置斜杠 + 全部内置工具 + MCP 工具名（`buildSlashItems`） |
| `terminalSync.ts` | 2.5 KB | 终端尺寸/事件同步辅助 |
| `Splash.tsx` | 1.9 KB | 启动横幅 |
| `ChatWithSplash.tsx` | 1.0 KB | 启动时先 `Splash` → 再切 `ChatApp` |

### 14.4 `llm/` — LLM 调用核心（9 个文件）

> **整个项目最复杂的模块**。`runLoop.ts` 23.6 KB 是单文件之最。

| 文件 | 大小 | 作用 |
|---|---|---|
| `runLoop.ts` | **23.6 KB** | **核心循环**：按 `provider` 分发到 `runAnthropic` / `runOpenAI` / `runGemini`；流式 SSE；`content_block_stop` 时立即派发工具（Anthropic 路径并行，OpenAI/Gemini 收齐后串行）；90s 闲置 watchdog + 180s 整体超时 + `MAX_TOOL_STEPS=48` |
| `toolGateAgent.ts` | 7.8 KB | 工具安全 L0/L0.5/L1/L2 评估；`evaluateToolSafety` → `evaluateByRules` → `llmEvaluate`（profile=`gate`） |
| `compactSession.ts` | 6.7 KB | 自动会话压缩；`findSafeCompactSplitIndex` 保护 tool 链完整 → `messagesToCompactTranscript` 截断到 ≤ 400KB → 调 `compact` profile 出中文摘要 ≤ 24KB |
| `oneShotCompletion.ts` | 3.4 KB | 单次 LLM 完成（gate / compact 共用） |
| `formatToolConfirm.ts` | 2.3 KB | `CONFIRMABLE_BUILTIN_TOOLS` 命中时把工具参数美化为可读 detail，喂给 L2 gate LLM |
| `messagesTranscript.ts` | 2.2 KB | `messages → 文本 transcript`（压缩用 + gate 看历史用） |
| `estimateTokens.ts` | 1.2 KB | 粗估 token 数（**不含 system 段，已知缺陷见 §13**） |
| `persisted.ts` | 1.0 KB | `PersistedMessage` 类型 + `truncateToolResults`（保护 `session.json` 体积，单条 tool 结果上限 8000 字符） |
| `compactionSettings.ts` | 0.9 KB | 解析 `config.compaction.*` 默认值 |

### 14.5 `tools/` — 内置工具实现（5 个文件）

> 14 个工具的定义与执行；详见 §7。`repoTools.ts` 是文件类工具的核心。

| 文件 | 大小 | 作用 |
|---|---|---|
| `repoTools.ts` | **14.1 KB** | 文件类工具实现：`read_file` / `list_directory` / `glob_files` / `grep_files` / `write_file` / `str_replace`；通过 `workspacePaths` 严格限制在 `sessionCwd` 下 |
| `runner.ts` | 13.5 KB | `runBuiltinTool(name, argsJson, ctx)`：按工具名分发到具体实现；统一 `{ok, code, stdout, stderr}` 错误格式；调用 `bash` / `http_request` / 各类记忆工具 |
| `definitions.ts` | 12.3 KB | `BUILTIN_TOOLS` 14 项 JSON Schema 定义（提交给 LLM 的 tool_use 列表） |
| `workspacePaths.ts` | 1.0 KB | `isPathInsideWorkspace(root, target)` + `resolveWorkspacePath` 防路径穿越 |
| `textDiff.ts` | 0.5 KB | `fileUnifiedDiff(rel, old, new)` + 96 KB 截断；写入 `EditHistory` 与工具结果展示 |

### 14.6 `liveui/` — Electron 桌面伴侣（10 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `wsSession.ts` | **12.4 KB** | **LiveUI 心脏**：WebSocket Server（默认 127.0.0.1:8080）；TTS 合成调度；30Hz mouth pump；ASR 路由；与 Electron 渲染端 14 种消息双向通信 |
| `protocol.ts` | 6.0 KB | WS 协议：`ASSISTANT_STREAM` / `ACTION` / `AUDIO_CHUNK` / `STATUS_PILL` / `SLASH_COMPLETION` / `USER_INPUT` / `USER_COMPOSER` / `INTERRUPT` / `MIC_AUDIO` / `LIVEUI_INTERACTION` 等 |
| `spriteExpressionManifestCore.ts` | 5.4 KB | 解析 `expressions.json`：`exp_happy.png` / `exp_sad.png` ... → 表情映射 |
| `resolveModelPath.ts` | 5.0 KB | 解析 Live2D `model3.json` 或 sprite expression dir（兼容 Open-LLM-VTuber `model_dict.json` 格式） |
| `emotionParse.ts` | 4.8 KB | 从 LLM 流式 chunk 抓 `[Happy]` / `[Surprised]` / `[Angry]` 等情感标签 → 触发 `ACTION` 消息 |
| `spawnRenderer.ts` | 3.1 KB | spawn Electron 子进程（`liveui/electron-main.cjs`）+ 传递 model3 / sprite dir / voiceMicJson / figureZoom |
| `voiceMicEnv.ts` | 1.8 KB | `INFINITI_LIVEUI_VOICE_MIC_*` 环境变量 → `voiceMicJson`（RMS 阈值、静音切段时长） |
| `spriteExpressionManifest.ts` | 1.4 KB | 默认露娜风格 manifest（fallback） |
| `streamMouth.ts` | 1.3 KB | 30Hz `SYNC_PARAM(ParamMouthOpenY)` 嘴型动画推送（基于 TTS 流） |
| `speakCommandLine.ts` | 0.5 KB | `/speak <text>` 斜杠命令的 LiveUI 朗读封装 |

### 14.7 `prompt/` — System Prompt 装配（6 个文件）

> 拼接顺序详见 §10。

| 文件 | 大小 | 作用 |
|---|---|---|
| `loadProjectPrompt.ts` | 3.0 KB | 加载 `SOUL.md` / `INFINITI.md`，按 fallback 链查找：cwd → 包内 → 内置 |
| `builtinToolPolicy.ts` | 2.1 KB | "**内置工具与 TUI 边界**"段落（提示模型如何选择工具） |
| `builtinCodeQuality.ts` | 1.6 KB | "**内置代码质量约束**"段落 |
| `memoryNudge.ts` | 1.4 KB | "**主动写记忆**"提醒段落 |
| `systemBuilder.ts` | 1.2 KB | `buildSystemWithMemory(cfg, cwd)` 入口；按 §10 顺序拼接 8 段 |
| `liveUiExpressionNudge.ts` | 0.7 KB | LiveUI 模式下提醒 LLM 输出 `[Happy]` 等情感标签 |

### 14.8 `memory/` — 记忆系统（5 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `knowledgeGraph.ts` | 6.0 KB | 时序知识图谱（SQLite + 三元组 + `valid_from`/`ended`）；动作 `add` / `invalidate` / `query` / `timeline` / `stats` |
| `structured.ts` | 5.4 KB | 结构化记忆 `memory.json` CRUD：`add` / `replace` / `remove` / `list`；**6000 字硬上限**；标签 `fact / preference / lesson / convention / environment / other` |
| `userProfile.ts` | 5.2 KB | 用户画像 `user_profile.json` CRUD；标签 `tech_stack / communication / workflow / background / other` |
| `vectorStore.ts` | 3.8 KB | sqlite-vec 向量存储（`vectors.db`，384 维）；`addVectorDoc` / `searchVectors` / `isVectorStoreAvailable` |
| `store.ts` | 1.8 KB | 旧版自由文本 `memory.md` 的 read/append/merge（兼容 `update_memory`，**已弃用**） |

### 14.9 `session/` — 会话持久化（3 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `archive.ts` | 4.7 KB | 归档当前会话到 `sessions.db`；建 FTS5 索引 `session_messages_fts`；`searchSessions` 全文检索 |
| `file.ts` | 1.2 KB | `loadSession(cwd)` / `saveSession(cwd, msgs)` 操作 `session.json`；调用 `truncateToolResults` |
| `editHistory.ts` | 0.7 KB | `EditHistory` 栈：`write_file` / `str_replace` 前后快照，供 `/undo` 弹栈回滚 |

### 14.10 `skills/` — Skill 安装与加载（4 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `manager.ts` | 2.4 KB | `manage_skill` 工具实现：自创建 / 局部更新 / 删除 `.infiniti-agent/skills/<id>/SKILL.md` |
| `install.ts` | 2.2 KB | `skill add/install <source>`：从 `owner/repo` / git URL / 本地路径安装到 `.infiniti-agent/skills/<id>/` |
| `tracker.ts` | 1.9 KB | `skill_usage.json` 记录每个 skill 被工具调用次数 + 最后使用时间（保留最近 200 条） |
| `loader.ts` | 1.8 KB | 扫描 `.infiniti-agent/skills/*/SKILL.md` → `LoadedSkill[]` → `skillsToSystemBlock` 拼接到 system prompt |

### 14.11 `tts/` — 语音合成（5 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `mossTtsNano.ts` | 8.2 KB | 本地 MOSS-TTS-Nano FastAPI 客户端（`/api/generate-stream` 流式 PCM） |
| `voxcpmTts.ts` | 5.0 KB | 本地 VoxCPM 客户端（对接 `scripts/voxcpm-tts-serve.py`） |
| `minimaxTts.ts` | 3.6 KB | MiniMax 在线 TTS（整段合成） |
| `markdownToTtsPlainText.ts` | 1.8 KB | 朗读前剥离 markdown / 代码块 / URL，避免 TTS 读出 `***` 等噪音 |
| `engine.ts` | 0.9 KB | 接口 `TtsEngine`：`synthesize` 整段 + 可选 `synthesizeStream`（流式 PCM） |

### 14.12 `asr/` — 语音识别（2 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `sherpaOnnxAsr.ts` | 2.9 KB | 本地 sherpa-onnx-node（SenseVoice）离线 ASR |
| `whisperAsr.ts` | 1.5 KB | OpenAI Whisper 在线 API 客户端 |

### 14.13 `avatar/` — 头像生成辅助（3 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `openRouterImageGen.ts` | 3.3 KB | OpenRouter 图像 API 调用封装（`/v1/images/generations` 兼容） |
| `transparentizePngBackground.ts` | 2.9 KB | "**边缘连通分量**"识别背景 → 透明化（用于 `generate_avatar` 输出） |
| `transparentizePngBackground.test.ts` | — | 透明化算法单测 |

### 14.14 `config/` — 配置层（3 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `io.ts` | **17.4 KB** | `loadConfig` / `saveProjectConfig` / `migrate` / `upgrade`；含旧"平铺 llm" → `profiles` 兼容；`ensureLocalAgentDir`；`configExistsSync` |
| `types.ts` | 9.7 KB | `InfinitiConfig` 主类型 + `resolveLlmProfile(cfg, name)` profile 解析 + 各模块子类型（mcp/compaction/thinking/liveUi/tts/asr/avatarGen） |
| `defaults.ts` | 0.8 KB | 默认 baseUrl / 模型 / 端口等常量；`ADD_LLM_DEFAULT_BASE` 等 |

### 14.15 `mcp/` — MCP 服务器集成（1 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `manager.ts` | 4.7 KB | `McpManager`：`start` 时 spawn 每个 stdio 服务器 + `client.listTools()`；自动注册为 `mcp__<srv>__<tool>`（≤ 64 字符截断）；`call(name, argsJson)` → `client.callTool` → 序列化 `out.content`（> 200KB 截断） |

### 14.16 `utils/` — 通用工具（2 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `formatError.ts` | 0.7 KB | 把 `unknown` 错误格式化为可读 string（含 stack） |
| `agentDebug.ts` | 0.4 KB | `agentDebug(...args)`：`--debug` 时往 stderr 打印；其它时候静默 |

### 14.17 `types/` — 第三方类型补丁（1 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `sherpa-onnx-node.d.ts` | 1.0 KB | 给 `sherpa-onnx-node` 这个 npm 包补 TypeScript 类型声明（包本身没带 .d.ts） |

### 14.18 模块依赖速查

```text
cli.tsx
  ├─► runCliPrompt.ts (cli 命令)
  ├─► ui/ChatApp.tsx (chat/live 命令)
  ├─► ui/InitWizard.tsx (init 命令)
  ├─► cli/* (sync/generate_avatar/set_live_agent/test_asr/...)
  ├─► link.ts (link 命令)
  └─► skills/install.ts (skill 命令)

runCliPrompt.ts  &  ui/ChatApp.tsx
  ├─► mcp/manager.ts (启动 MCP)
  ├─► session/file.ts (加载/保存会话)
  ├─► llm/estimateTokens.ts → session/archive.ts → llm/compactSession.ts (自动压缩)
  ├─► prompt/systemBuilder.ts (装配 system prompt)
  │     ├─► prompt/loadProjectPrompt.ts (SOUL/INFINITI)
  │     ├─► memory/structured.ts + memory/userProfile.ts
  │     ├─► skills/loader.ts
  │     └─► prompt/{builtinCodeQuality,builtinToolPolicy,memoryNudge,...}
  └─► llm/runLoop.ts (核心循环)
        ├─► llm/toolGateAgent.ts (L0-L2 安全评估)
        ├─► tools/runner.ts (内置工具)
        │     └─► tools/{repoTools,workspacePaths,textDiff}
        └─► mcp/manager.ts (MCP 工具)

ui/ChatApp.tsx (live 模式额外)
  └─► liveui/wsSession.ts (WebSocket Server)
        ├─► liveui/protocol.ts (消息类型)
        ├─► liveui/spawnRenderer.ts (spawn Electron)
        ├─► tts/* (合成)
        ├─► asr/* (识别)
        └─► liveui/{emotionParse,streamMouth,resolveModelPath,...}
```

---

## 15. 参考导航（重要源文件）

- 入口：`@/src/cli.tsx`、`@/src/runCliPrompt.ts`
- TUI：`@/src/ui/ChatApp.tsx`、`@/src/ui/InitWizard.tsx`、`@/src/ui/slashCompletions.ts`
- LLM 核心：`@/src/llm/runLoop.ts`、`@/src/llm/toolGateAgent.ts`、`@/src/llm/compactSession.ts`、`@/src/llm/oneShotCompletion.ts`
- 工具：`@/src/tools/definitions.ts`、`@/src/tools/runner.ts`、`@/src/tools/repoTools.ts`
- MCP：`@/src/mcp/manager.ts`
- 提示词：`@/src/prompt/systemBuilder.ts`、`@/src/prompt/loadProjectPrompt.ts`、`@/src/prompt/builtinToolPolicy.ts`、`@/src/prompt/builtinCodeQuality.ts`、`@/src/prompt/memoryNudge.ts`
- 记忆：`@/src/memory/structured.ts`、`@/src/memory/userProfile.ts`、`@/src/memory/knowledgeGraph.ts`
- 会话：`@/src/session/file.ts`、`@/src/session/archive.ts`、`@/src/session/editHistory.ts`
- LiveUI：`@/src/liveui/wsSession.ts`、`@/src/liveui/protocol.ts`、`@/src/liveui/emotionParse.ts`、`@/src/liveui/spawnRenderer.ts`
- 配置：`@/src/config/types.ts`、`@/src/config/io.ts`、`@/src/config/defaults.ts`
- 路径常量：`@/src/paths.ts`
- LinkYun 集成：`@/src/cli/linkyunSync.ts`、`@/src/link.ts`、`@/src/cli/generateAvatar.ts`、`@/src/cli/setLiveAgent.ts`
