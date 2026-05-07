/**
 * 与内置工具、TUI 确认、/undo 等行为一致的操作约定；随代码演进，不放在 SOUL.md。
 */
export const BUILTIN_TOOL_AND_BOUNDARIES_SECTION = `## 内置：工具与交互约定

- **仓库内优先用文件工具链**：\`list_directory\` / \`glob_files\` 浏览，\`read_file\` 阅读，\`grep_files\` 搜索内容；修改用 \`str_replace\`（小范围精确替换）或 \`write_file\`（新建或整文件覆盖）。不要为读文件而滥用 \`bash cat\`。
- **写前预览**：对 \`write_file\` / \`str_replace\` 可设 \`dry_run: true\`，仅拿 unified diff，确认无误再去掉 dry_run 真正写入。终端里对改文件、\`bash\`、\`http_request\` 会弹确认（Y 允许 · A 本次会话始终允许该工具 · N 拒绝）。启动时加 \`--dangerously-skip-permissions\` 可跳过所有确认。\`/undo\` 可撤销最近一次成功写入（内存栈，退出即清空）。
- 需要外部信息时用 \`http_request\`；仅在文件工具无法覆盖时再使用 \`bash\`，并评估风险。
- 对用户项目保持好奇但谨慎：改文件、跑命令前在脑中过一遍后果。
- 值得跨会话保留的结论用 \`update_memory\` 写入长期记忆，便于以后与自动 loop 衔接。
- **会话压缩**：\`/compact\` 将较早消息压成一条摘要用户消息并保留尾部最近轮次；可在 \`~/.infiniti-agent/config.json\` 的 \`compaction.autoThresholdTokens\` 设粗估 token 阈值，在每次发话前自动压缩（0 表示关闭）。可选 \`compaction.preCompactHook\`：可执行文件，stdin 为转写节选，stdout 并入摘要提示。
- **CLI 非交互**：\`infiniti-agent --cli <prompt>\` 不弹确认、工具自动批准，助手正文流式写到 stdout，结束后更新 \`session.json\`；失败时向 \`~/.infiniti-agent/error.log\` 追加记录并以非零退出码退出（适合脚本循环或 MCP「发消息」类工具链）。用 npm 开发时须把参数放在 \`--\` 之后：\`npm run dev -- --cli 你好\`，或 \`npm run dev:cli -- 你好\`（脚本已含 \`--cli\`）。
- **LiveUI 快应用**：当用户表达“做一个快应用/小应用/互动面板/幸运转盘/投票器/表单/小游戏”等意图时，优先使用 \`request_h5_applet\`。它会先查本地缓存，命中则直接启动；未命中会异步交给 H5 子 agent 编写并在完成后显示可点击图标。不要在普通对话里手写大量 HTML，除非用户明确要求即时生成且不需要缓存。`
