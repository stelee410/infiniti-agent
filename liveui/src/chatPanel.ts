import { renderLiveUiBubbleMarkdown } from './bubbleMarkdown.ts'

/**
 * 对话历史抽屉（桌面伴侣 GUI v0 · A）。
 *
 * 形象居中、对话为辅：默认折叠（与现状一致），点窗口工具里的对话按钮滑出右侧抽屉，
 * 把转瞬即逝的字幕气泡沉淀成可滚动的历史。纯客户端，复用已有的 ASSISTANT_STREAM
 * 与 USER_INPUT 文本，不新增协议、不动内核。
 */
export type ChatPanelHandle = {
  /** 追加一条用户消息（已发送的输入）。 */
  addUserMessage(text: string): void
  /** 新一轮助手回复开始（对应 ASSISTANT_STREAM 的 reset）。 */
  beginAssistantStream(): void
  /** 流式更新当前助手消息（传入累计的、已去标签的显示文本）。 */
  updateAssistantStream(displayText: string): void
  /** 当前助手回复结束（对应 done / 转为就绪）。 */
  endAssistantStream(): void
  /** 工具活动卡片：同一 id 由 start → done/error 更新同张卡片。 */
  addActivity(data: { id: string; tool: string; status: 'start' | 'done' | 'error'; summary?: string }): void
  /** 展开/折叠抽屉；force 指定目标状态。 */
  toggle(force?: boolean): void
  isOpen(): boolean
}

const STICK_THRESHOLD_PX = 48

export function initChatPanel(opts?: {
  onOpenChange?: (open: boolean) => void
}): ChatPanelHandle {
  const panel = document.getElementById('liveui-chat-panel')
  const list = document.getElementById('liveui-chat-list')
  const toggleBtn = document.getElementById('liveui-btn-chat') as HTMLButtonElement | null
  const closeBtn = document.getElementById('liveui-chat-close') as HTMLButtonElement | null

  let open = false
  let streamingEl: HTMLDivElement | null = null
  let stickToBottom = true
  const activityEls = new Map<string, HTMLDivElement>()

  const isNearBottom = (): boolean => {
    if (!list) return true
    return list.scrollHeight - list.scrollTop - list.clientHeight <= STICK_THRESHOLD_PX
  }

  const scrollToBottom = (): void => {
    if (list) list.scrollTop = list.scrollHeight
  }

  const appendMessage = (role: 'user' | 'assistant'): HTMLDivElement => {
    const el = document.createElement('div')
    el.className = `liveui-chat-msg liveui-chat-msg--${role}`
    const body = document.createElement('div')
    body.className = 'liveui-chat-msg-body liveui-md-root'
    el.appendChild(body)
    list?.appendChild(el)
    return body
  }

  const addUserMessage = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    // 用户发起新一句，结束上一条流式助手消息。
    streamingEl = null
    const body = appendMessage('user')
    body.textContent = trimmed
    stickToBottom = true
    scrollToBottom()
  }

  const beginAssistantStream = (): void => {
    streamingEl = null
  }

  const updateAssistantStream = (displayText: string): void => {
    const text = displayText ?? ''
    if (!text.trim()) return
    stickToBottom = isNearBottom()
    if (!streamingEl) streamingEl = appendMessage('assistant')
    streamingEl.innerHTML = renderLiveUiBubbleMarkdown(text)
    if (stickToBottom) scrollToBottom()
  }

  const endAssistantStream = (): void => {
    streamingEl = null
  }

  const ACTIVITY_ICON: Record<string, string> = { start: '○', done: '✓', error: '✕' }

  const addActivity = (data: {
    id: string
    tool: string
    status: 'start' | 'done' | 'error'
    summary?: string
  }): void => {
    const text = (data.summary || data.tool || '').trim()
    if (!text) return
    const atBottom = isNearBottom()
    let el = activityEls.get(data.id)
    if (!el) {
      el = document.createElement('div')
      el.className = 'liveui-chat-activity'
      const icon = document.createElement('span')
      icon.className = 'liveui-chat-activity-icon'
      const body = document.createElement('span')
      body.className = 'liveui-chat-activity-text'
      el.append(icon, body)
      list?.appendChild(el)
      activityEls.set(data.id, el)
    }
    el.dataset.status = data.status
    const iconEl = el.querySelector('.liveui-chat-activity-icon')
    const textEl = el.querySelector('.liveui-chat-activity-text')
    if (iconEl) iconEl.textContent = ACTIVITY_ICON[data.status] ?? '○'
    if (textEl) textEl.textContent = text
    if (atBottom) scrollToBottom()
  }

  const toggle = (force?: boolean): void => {
    open = typeof force === 'boolean' ? force : !open
    document.body.classList.toggle('liveui-chat-open', open)
    if (panel) panel.setAttribute('aria-hidden', String(!open))
    if (toggleBtn) toggleBtn.setAttribute('aria-pressed', String(open))
    if (open) {
      stickToBottom = true
      requestAnimationFrame(scrollToBottom)
    }
    opts?.onOpenChange?.(open)
  }

  toggleBtn?.addEventListener('click', () => toggle())
  closeBtn?.addEventListener('click', () => toggle(false))

  return {
    addUserMessage,
    beginAssistantStream,
    updateAssistantStream,
    endAssistantStream,
    addActivity,
    toggle,
    isOpen: () => open,
  }
}
