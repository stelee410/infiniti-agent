# 待办与可增强项

与参考实现（如 `ref/extracted`）及当前代码缺口对照：**尚未实现、但值得做**的条目集中在此，便于排期。实现后可将对应小节删除或移到变更说明。

---

## 会话压缩（Compaction）

- **Microcompact**：在全文摘要前先压缩/裁剪过大的工具返回（或重复 `read_file` 内容），降低摘要请求体积与费用，再跑现有 `compactSessionMessages`。
- **部分压缩（partial compact）**：支持从某条消息为界「向上」或「向下」只摘要一侧，便于用户定点整理长会话而不丢近期细节。
- **自动阈值更完整**：当前 `autoThresholdTokens` 仅粗估 `messages`，未计入 `system`（含 SOUL、技能、记忆等）。可改为 `system + messages` 联合估算，或单独设 `systemBudgetTokens` 常数补偿。

---

## 权限与工具治理

- **规则化权限**：在逐项确认与 `/approve-all` 之间增加 `allow` / `deny` / `ask` 规则（如按工具名、bash 命令前缀），持久化到 `~/.infiniti-agent`，减少重复点击。
- **工具结果与上下文**：对超大 tool 输出做统一截断策略；可选维护「本会话已读文件」提示，减少模型重复 `read_file` 同一全文。
- **Hooks 扩展**：除 `preCompactHook` 外，可增加 `preTool` / `postTool` 等生命周期钩子（脚本或命令），便于审计与团队流程接入。

---

## 架构与体验

- **子 Agent / 任务委派**：对深搜、规划类任务拆成子上下文（可共用配置或便宜模型），主会话只收结论，降低主线程 token 与干扰。
- **Plan 模式**：仅规划不执行工具（或只读工具），与权限 `plan` 类体验对齐。
- **遥测与调试开关**：可选匿名事件或本地 debug 日志（功能 flag），便于排查压缩/工具失败，默认关闭。

---

## 文档与配置

- **config 示例**：在文档或 init 向导中给出 `compaction`、`hooks`、权限规则的完整 JSON 样例（与 `INFINITI.md` 互补）。
- **Windows / hook**：说明 `preCompactHook` 在 Windows 下需可执行文件或 `node xxx.js` 包装等注意事项。
