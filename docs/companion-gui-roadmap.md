# 桌面伴侣 GUI 演进计划（new-gui）

> 定位：**陪伴优先** —— 形象居中，对话/任务为辅，做成"会干活的桌面伴侣"。
> 原则：**进化现有 Live，不重写、不换战略、不动内核**。新 GUI 只是同一 WebSocket 事件流的又一个消费者。

## 0. 背景与决策

当前形态是 **一个 agent 内核 + 两个半成品客户端**：

- **TUI（Ink, `src/ui/ChatApp.tsx`）**：能力全，但对普通用户劝退。
- **Live（Electron + Live2D/real2d + 语音, `liveui/`）**：亲和力满，但只是"形象叠加层"，缺工作界面，所以"交互不够"。

两者共用同一套 agent 事件流（WebSocket）。因此解决"普通用户不友好"的正确做法不是做第三种范式（Codex 式重写），而是 **把 Live 升级成完整应用**：保留形象作为差异化主角，在其周围补上普通用户必需的"看得见、点得动"的界面。

经评审，曾考虑的"Codex 式 agentOS 终端重写"会放弃唯一护城河（虚拟人/情绪/语音）跳进红海，性价比低，**不采纳**。本计划只动交互层（可逆、低风险）。

## 1. 普通用户真正缺的 3 样

| 缺口 | 现状 | 后果 |
|---|---|---|
| **A. 对话留不住** | 只有转瞬即逝的字幕气泡 `#speech-bubble` | 说过的话找不回，没安全感 |
| **B.「她在干什么」看不见** | 工具/任务执行时只有 `STATUS_PILL`（busy/ready） | "会干活"对用户是黑盒——而这正是 TUI 唯一不可替代之处 |
| **C. 审批没出口** | —— | 见下，**已确认基本不是问题** |

### C 的确认结论（重要）

Live 模式工具审批**已经能用、不会卡死**，是**对话式**而非阻塞弹窗：

- 共用工具循环 `src/llm/runLoop.ts:215–246`，需确认时返回 `status: blocked` + "此操作需要用户确认…获得明确确认后重试"；
- 这句话本来就走 `ASSISTANT_STREAM` 由形象说/显示出来；
- 用户回"可以/确定/yes"，`src/llm/toolGateAgent.ts:30–47` 的 `userApprovedAfterBlock()` 检测关键词放行；
- **没有**独立 APPROVAL 协议，TUI 与 Live 完全一致。

→ **结论：C 对 v0 几乎免费。** 审批文本随 `ASSISTANT_STREAM` 流出，做完 A（对话历史）就自然可见。"允许/拒绝"按钮只是把"可以"注入输入框的语法糖，留作后续可选项。

## 2. v0 范围：一个「对话 + 活动」抽屉

**= A（对话历史）+ B（活动卡片）**。

### 布局——保住伴侣感

- **折叠态（默认）**：与现状一致，形象居中 + 字幕气泡，纯陪伴。
- **展开态**：点侧边按钮 → 右侧/底部滑出抽屉，形象自动缩让（复用 `windowManager.requestLayout()` / `figureManager`）；抽屉内为对话历史 + 活动卡片。再点折叠回纯伴侣。
- 切换用 body class（仿 `liveui-config-open` 模式），按钮加进既有 `#liveui-icon-cluster` / `#liveui-window-tools`。

## 3. 可复用清单（绝大部分免写）

| 要做的事 | 直接复用 | 位置 |
|---|---|---|
| 抽屉面板开合/构造基建 | configPanel 那套（`el()` 构造、body class 切换、面板 DOM 模式） | `liveui/src/configPanel.ts` |
| 渲染助手富文本 | `renderLiveUiBubbleMarkdown()` | `liveui/src/bubbleMarkdown.ts` |
| 助手文本来源（无需新协议） | `ASSISTANT_STREAM`（带 `done` 标志，`bubbleTarget` 已存全文） | `liveui/src/main.ts:2683–2698` |
| 用户消息来源 | 在发送 `USER_INPUT` 处回显 | `liveui/src/main.ts:2062` |
| 输入框/回车/历史/语音 | `#liveui-user-line` 全套 | `liveui/src/main.ts:2775–2796`、`inputHistory.ts` |
| 忙/闲状态 | `STATUS_PILL` | `liveui/src/main.ts:2699–2714` |
| 布局缩让 | `windowManager` / `figureManager` / `layoutCoordinator` | 同名文件 |

→ **A 几乎是纯客户端活**：在 `main.ts` 维护一个消息数组，监听已有 `ASSISTANT_STREAM`（`done` 时落一条）+ 回显 `USER_INPUT`，用现有 markdown 渲染进抽屉。**零新协议。**

## 4. 唯一需要新写的一点点（B）

服务端目前只发 `STATUS_PILL`，不发具体工具调用。为"会干活可见"，新增一个轻量事件：

- **协议**：`ACTIVITY`，载荷约 `{ id, tool, status: 'start' | 'done' | 'error', summary? }`。
  - 服务端定义：`src/liveui/protocol.ts`（加入 `LiveUiMessage` 联合类型）。
  - 服务端发出：工具分发处 `src/llm/runLoop.ts`（dispatch 前后），经 `src/liveui/wsSession.ts` 推送，仅在 `liveUi` 存在时发。
  - 客户端渲染：`liveui/src/main.ts` 消息监听里把 `ACTIVITY` 渲染成卡片（"正在读取文件 / 已运行命令 …"）。
- 这是整个 v0 **唯一**的新协议 + 少量服务端埋点。内核、记忆、情绪引擎一行不改。

## 5. 里程碑

- **v0 ✅ 已实现**：对话历史抽屉（A，纯客户端 `chatPanel.ts`）+ 活动卡片（B，新增 `ACTIVITY` 事件，dispatch 收口埋点）。普通用户可"看着她、看她干活、不开终端"。
  - A：`liveui/src/chatPanel.ts`、`index.html`（`#liveui-btn-chat` / `#liveui-chat-panel`）、`main.ts`（回显 USER_INPUT、ASSISTANT_STREAM 流式写入）
  - B：`src/liveui/protocol.ts`（`LiveUiActivityMessage`）、`src/liveui/wsSession.ts`（`sendActivity`）、`src/llm/runLoop.ts`（dispatch 埋点）、`src/liveui/activitySummary.ts`（文案）、`chatPanel.addActivity`
- **v0.5 ✅ 已实现**：自适应披露，解决"精灵模式：复杂不够用、简单又冗余"。
  - 自适应活动条 `liveui/src/activityStrip.ts`：无操作全隐藏（纯精灵）；有工具跑时形象旁浮一行、完成后自愈消失（轻任务不冗余）；点活动行一键展开抽屉（重任务够用）；精灵/极简模式下同样工作。
  - 就地审批：`gate.decision==='ask'` 时下发 `APPROVAL_REQUEST`（`src/llm/runLoop.ts` + `wsSession.sendApprovalRequest` + `protocol.ts`），活动条弹「允许/拒绝」，点允许=发送确认词，复用现有对话式审批。
- **后续**：把 `STATUS_PILL` 升级为结构化任务列表；文件改动 diff 视图；按需扩展。

## 6. 风险与边界

- 全部为客户端改动 + 一个新事件，**可逆、低风险**。
- 不改内核 / 记忆 / 情绪引擎 / TUI（TUI 保留为开发者"专家模式"）。
- 新 GUI 必须保留形象为主角，**不可退化成纯文字聊天窗**（否则等于在交互层重犯"扔掉护城河"的错）。

## 7. 涉及文件速查

- 客户端：`liveui/src/main.ts`、`liveui/index.html`（新增 `#liveui-chat-panel`）、可抽出 `liveui/src/chatPanel.ts`（仿 `configPanel.ts`）、`liveui/src/panelLayoutPolicy.ts`
- 服务端（仅 B）：`src/liveui/protocol.ts`、`src/liveui/wsSession.ts`、`src/llm/runLoop.ts`
