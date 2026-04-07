# INFINITI — 项目层说明

本文件面向**当前仓库 / 工作区**的运行约定；与模型人格、语气相关的设定统一写在 **[SOUL.md](./SOUL.md)**。运行时注入顺序为：**SOUL.md → INFINITI.md → 内置编写高质量代码约定 → 内置工具与交互约定**（后两段随 CLI 版本更新，不在 SOUL 中维护）。

## 你可以在这里写

- 技术栈、目录结构、构建与测试命令
- 与业务相关的术语表或禁区
- 希望 Agent 默认遵守的仓库级规范

## 覆盖方式

- 若在项目根目录放置自己的 `SOUL.md` / `INFINITI.md`，将**优先于** `infiniti-agent` 包内默认文件使用。

## 会话压缩（config.json）

在 `~/.infiniti-agent/config.json` 可增加可选块 `compaction`：

- `autoThresholdTokens`：粗估 token（约 4 字符计 1）达到或超过时，在每次向模型发话**前**自动压缩 `messages`（不含 system）；`0` 或不写表示关闭。
- `minTailMessages`：压缩后至少保留的尾部消息条数（默认 16），需保证工具调用链完整时可调大。
- `maxToolSnippetChars`：摘要请求里单条工具输出最多字符（默认 4000）。
- `preCompactHook`：可执行文件路径（可相对会话 cwd）；stdin 为 UTF-8 转写节选，stdout 非空则并入摘要提示。

终端中也可用斜杠命令 `/compact`（可选后跟附加说明文字）。
