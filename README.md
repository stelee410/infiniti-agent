# Infiniti Agent

终端里的多模型 Agent（Anthropic / OpenAI / Gemini），React + Ink TUI，支持 MCP、Skills、会话持久化与 `--cli` 非交互模式。

## 安装

npm 上的**包名**为 `linkyun-infiniti-agent`（避免与保留/冲突短名 `infiniti-agent` 导致发布 E404）；安装后**命令行仍为** `infiniti-agent`。

```bash
npm install -g linkyun-infiniti-agent
```

安装后可用命令：`infiniti-agent`（由 `package.json` 的 `bin` 字段注册）。

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
npm login               # 或确认 token 含「发布」权限，非只读
npm publish
# 若账号开启 2FA：npm publish --otp=xxxxxx
```

### 若出现 `E404` / `PUT ... Not found`

npm 常把**无发布权限、Token 只读、未登录**误报成 404。请依次检查：

1. `npm whoami` 能显示用户名；`npm config get registry` 为 `https://registry.npmjs.org/`（注意末尾 `/`）。
2. 在 [npm Access Tokens](https://www.npmjs.com/settings/~/tokens) 使用**具备 Publish 权限**的 Classic Token，或重新 `npm login`。
3. 开启 2FA 时发布必须带 `--otp`。

包名使用 `linkyun-infiniti-agent` 可降低与 npm 策略下短名冲突的概率；全局命令仍为 `infiniti-agent`。

## 协议

见 `package.json` 中的 `license` 字段。
