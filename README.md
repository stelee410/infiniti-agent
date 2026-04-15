# Infiniti Agent

项目级 AI 智能体框架。每个目录启动的 agent 都可以拥有独立的 skills、memory 和 session，天然支持多智能体协同。

支持 Anthropic (Claude) / OpenAI / Gemini 等多模型，可配置多个 LLM profile 用于不同场景。

## 快速开始

```bash
# 安装
npm install -g linkyun-infiniti-agent

# 首次配置（交互式，支持一次配置多个 LLM profile）
infiniti-agent init

# 在项目目录初始化独立实例
cd your-project
infiniti-agent migrate

# 开始对话
infiniti-agent
```

## 命令一览

| 命令 | 说明 |
|------|------|
| `infiniti-agent` | 进入交互对话（TUI） |
| `infiniti-agent chat` | 同上 |
| `infiniti-agent cli <prompt>` | 非交互执行一轮，结果输出到 stdout |
| `infiniti-agent init` | 配置 LLM（写入全局 `~/.infiniti-agent/config.json`） |
| `infiniti-agent migrate` | 将全局配置复制到当前目录 `.infiniti-agent/`，实现项目级独立 |
| `infiniti-agent upgrade` | 升级旧版 config.json 到最新格式 |
| `infiniti-agent link` | 从 SOUL.md 提取邮件配置，生成 `mail-poller.sh` 邮件轮询守护脚本 |
| `infiniti-agent skill add <source>` | 安装 Skill（支持 `owner/repo`、git URL、本地路径） |
| `infiniti-agent skill list` | 列出当前项目已安装的 Skills |
| `infiniti-agent live` | LiveUI：WebSocket + Electron 透明窗 + TUI（需先 `npm run build`） |

LiveUI 窗口为无边框透明窗：**鼠标移到人物（Live2D 或占位圆）上**会浮出半透明控制条，点击 **「⋮⋮ 拖动」** 即可拖动窗口；移开后面板短时淡出。

**Electron 窗口（默认）**：无边框、**透明**、置顶叠层。需要标题栏 + **视图** 菜单（重新加载、开发者工具、缩放等）时：`INFINITI_LIVEUI_DEBUG_WINDOW=1`。启动时自动打开 DevTools（独立窗口）：`INFINITI_LIVEUI_DEVTOOLS=1`；`infiniti-agent live` 带 **`--debug`** 时也会自动设置 DevTools。

渲染依赖 **Live2D Cubism Core**：已内置在 `liveui/public/live2dcubismcore.min.js`（构建时复制到 `dist/`），`index.html` 以**相对路径** `./live2dcubismcore.min.js` 加载，避免 Electron `file://` 下绝对路径 `/xxx.js` 指向磁盘根目录导致加载失败。模型入口为配置解析出的 `file:` 路径（`.model3.json`）。

**LiveUI / Live2D（`config.json` 顶层 `liveUi`，对齐 Open-LLM-VTuber 的目录与 `model_dict.json`）：**

- `live2dModelsDir`：模型根目录（如 `./live2d-models`，其下为 `模型名/runtime/*.model3.json`）。
- `live2dModelDict`：模型清单 JSON 路径，默认 `./model_dict.json`。
- `live2dModelName`：清单里某条目的 `name`（与 VTuber `character_config.live2d_model_name` 一致）。
- `live2dModel3Json`：若已离线下载，可直接写 `.model3.json` 路径（**优先于** dict+name）。
- `port`：WebSocket 端口；也可用 `infiniti-agent live -p 9000` 或环境变量 `INFINITI_LIVEUI_PORT` 覆盖。

**一键写入默认 `liveUi`（合并到项目的 `.infiniti-agent/config.json`，并在缺少 `./model_dict.json` 时从包内示例复制）：**

```bash
# 方式 A：在已 migrate 的项目根执行（把脚本路径换成你的 infiniti-agent 克隆目录）
cd ~/your-project
node ~/Dev/infiniti-agent/infiniti-agent/scripts/merge-liveui-config.mjs

# 方式 B：在 infiniti-agent 源码根执行，并传入项目路径
cd ~/Dev/infiniti-agent/infiniti-agent
npm run setup:liveui -- ~/your-project
```

将 Open-LLM-VTuber 的 `live2d-models` 文件夹拷到项目根下的 `live2d-models/`，与 `model_dict.json` 中的 `url` 一致即可校验通过。

**常用选项：**

```bash
infiniti-agent cli 查询天气 --debug              # 输出调试日志到 stderr
infiniti-agent cli 查询天气 --disable-thinking    # 禁用深度思考模式
infiniti-agent --dangerously-skip-permissions      # 跳过工具安全评估
```

## 项目级独立运行

每个目录下的 `.infiniti-agent/` 是该项目的独立数据空间：

```
your-project/
├── .infiniti-agent/
│   ├── config.json      # 项目级配置（不存在则 fallback 到全局）
│   ├── session.json     # 对话历史
│   ├── memory.md        # 长期记忆
│   ├── skills/          # 已安装的 Skills
│   └── error.log        # 错误日志
├── SOUL.md              # Agent 人格定义（可选）
├── INFINITI.md           # 项目说明 / 指令（可选）
└── ...
```

不同目录的 agent 完全隔离——可以各自安装不同的 skills，拥有不同的 memory 和对话历史。

## 自定义 Agent 行为

在项目根目录创建以下文件即可定制 agent：

- **`SOUL.md`** — 定义 agent 的人格、角色和行为准则
- **`INFINITI.md`** — 项目专属指令（也兼容 `CLAUDE.md`）

示例 `SOUL.md`：

```markdown
你是一个专注于 Python 后端开发的助手。
偏好使用 FastAPI 和 SQLAlchemy。
回复简洁，优先给出可运行的代码。
```

## 多 LLM Profile

在 `config.json` 中配置多个 LLM，用于不同场景：

```json
{
  "version": 1,
  "llm": {
    "default": "main",
    "profiles": {
      "main":    { "provider": "anthropic", "baseUrl": "https://api.anthropic.com", "model": "claude-sonnet-4-20250514", "apiKey": "sk-..." },
      "gate":    { "provider": "gemini",    "baseUrl": "https://generativelanguage.googleapis.com/v1beta", "model": "gemini-2.0-flash", "apiKey": "AIza..." },
      "compact": { "provider": "openai",    "baseUrl": "https://api.openai.com/v1", "model": "gpt-4.1-mini", "apiKey": "sk-..." }
    }
  }
}
```

| Profile | 用途 |
|---------|------|
| `main`（default） | 主对话模型 |
| `gate` | 工具安全评估（meta-agent，可用便宜快速的模型） |
| `compact` | 会话压缩摘要 |

旧格式（平铺 provider/model/apiKey）仍完全兼容，运行 `infiniti-agent upgrade` 即可自动升级。

## Skills

Skills 是可插拔的能力扩展，本质是 `SKILL.md` 文件注入到系统提示中：

```bash
# 从 GitHub 安装
infiniti-agent skill add owner/repo

# 从本地路径安装
infiniti-agent skill add ./my-skill

# 查看已安装
infiniti-agent skill list
```

你也可以直接在 `.infiniti-agent/skills/my-skill/SKILL.md` 中手写 skill。

## 内置工具

Agent 开箱即用以下工具（无需额外配置）：

- `read_file` / `write_file` / `str_replace` — 文件读写与编辑
- `list_directory` / `glob_files` / `grep_files` — 目录浏览与搜索
- `bash` — 执行 shell 命令
- `http_request` — HTTP 请求
- `update_memory` — 写入长期记忆

还可以通过 MCP 服务器扩展更多工具。

## 邮件轮询守护（link）

`infiniti-agent link` 从当前目录的 `SOUL.md` 中自动提取邮件相关配置（Agent 地址、Agent ID、API Key），生成一个开箱即用的 `mail-poller.sh` 守护脚本。

**前提：** `SOUL.md` 中需包含以下信息（格式不限，命令会自动识别）：

- Agent 地址：`xxx@xxx.amp.linkyun.co`
- Agent ID：UUID 格式（如 `30bc8485-c1af-4fad-b83b-5915c8673632`）
- API Key：以 `amk_` 开头的密钥

**使用方式：**

```bash
# 生成 mail-poller.sh
infiniti-agent link

# 前台运行（Ctrl-C 停止）
./mail-poller.sh

# 后台运行
nohup ./mail-poller.sh &

# 仅检查一次后退出
./mail-poller.sh --once
```

脚本每 60 秒检查一次 Mail Broker 收件箱，发现未读邮件时自动调用 `infiniti-agent cli` 处理。运行日志写入 `mail-poller.log`，终端仅显示单行状态。

## 无限循环运行示例

除了 `link` 生成的邮件轮询脚本，你也可以用最简单的方式让 agent 持续运行——`cli` 模式 + shell 循环：

```bash
#!/bin/bash
# loop-agent.sh — 每 60 秒执行一轮 agent 任务
while true; do
  infiniti-agent cli "检查 inbox/ 目录下的新文件，处理后移到 done/"
  sleep 60
done
```

或用 cron 定时触发：

```bash
# crontab -e
*/5 * * * * cd /path/to/project && infiniti-agent cli "检查并处理待办任务"
```

配合 `SOUL.md` 定义角色 + Skills 扩展能力，每个目录都可以成为一个独立的自动化智能体。

## 会话管理

- 对话历史自动保存在 `.infiniti-agent/session.json`
- 配置 `compaction.autoThresholdTokens` 可自动压缩过长的对话：

```json
{
  "compaction": {
    "autoThresholdTokens": 30000
  }
}
```

- TUI 中输入 `/clear` 清空当前会话，`/compact` 手动触发压缩

## 开发

```bash
git clone https://github.com/stelee410/infiniti-agent.git
cd infiniti-agent
npm install
npm run dev                          # 启动 TUI（开发模式）
npm run dev -- cli 你好               # CLI 模式
npm run build && npm link            # 全局安装本地版本
```

## 发布到 npm

```bash
npm run build
npm publish              # 包名: linkyun-infiniti-agent，命令: infiniti-agent
```

## 协议

见 `package.json` 中的 `license` 字段。
