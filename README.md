# Infiniti Agent

终端里的多模型 Agent（Anthropic / OpenAI / Gemini），React + Ink TUI，支持 MCP、Skills、会话持久化与 `--cli` 非交互模式。

## 安装

```bash
npm install -g infiniti-agent
```

安装后可用命令：`infiniti-agent`（与包内 `bin` 同名）。

## 首次配置

```bash
infiniti-agent init
```

按提示填写 `~/.infiniti-agent/config.json`（provider、模型、API Key 等）。

## 使用

```bash
# 进入对话界面（默认）
infiniti-agent
# 或
infiniti-agent chat

# 非交互执行一轮（自动批准工具，stdout 输出，更新 session）
infiniti-agent --cli "你的提示词"

# 子命令
infiniti-agent skill list
infiniti-agent skill install <git-url|本地路径>
```

开发本地仓库时，参数需通过 npm 传给脚本：

```bash
npm run dev:cli -- 你好
# 或
npm run dev -- --cli 你好
```

## 数据目录

配置与状态默认在 `~/.infiniti-agent/`（`config.json`、`session.json`、`memory.md`、`error.log` 等）。

## 维护者发布到 npm

```bash
npm run build
npm publish --dry-run   # 检查包内容
npm login
npm publish             # 首次会创建包；之后升版本号再发
```

全局安装：`npm install -g infiniti-agent`，需已配置 npm 账号且包名未被占用。

## 协议

见 `package.json` 中的 `license` 字段。
