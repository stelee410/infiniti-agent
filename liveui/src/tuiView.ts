import { renderLiveUiBubbleMarkdown } from './bubbleMarkdown.ts'
import type { LiveUiTuiView, LiveUiTuiViewMsg } from '../../src/liveui/protocol.ts'

/**
 * 窗口主对话区（窗口作主界面 · 全量对齐 TUI）。
 *
 * 接收服务端镜像过来的 TUI 视图模型（增量合并），把终端里渲染的对话历史与瞬态
 * 状态（流式/思考/错误/提示/状态行）原样画到窗口主区。普通用户无需开终端。
 */
export type TuiViewHandle = {
  apply(patch: LiveUiTuiView): void
}

const STICK_THRESHOLD_PX = 60

type ViewState = Required<Omit<LiveUiTuiView, 'messages'>> & { messages: LiveUiTuiViewMsg[] }

const DEFAULTS: ViewState = {
  messages: [],
  stream: '',
  thinking: '',
  error: null,
  notice: null,
  statusLine: null,
  busy: false,
  sessionReady: true,
}

export function initTuiView(opts: { strip: (s: string) => string }): TuiViewHandle {
  const root = document.getElementById('liveui-conversation-list')
  const state: ViewState = { ...DEFAULTS }

  const isNearBottom = (): boolean => {
    if (!root) return true
    return root.scrollHeight - root.scrollTop - root.clientHeight <= STICK_THRESHOLD_PX
  }

  const md = (s: string): string => renderLiveUiBubbleMarkdown(opts.strip(s))

  const msgEl = (role: string, header: string, html: string, hint?: string): HTMLElement => {
    const el = document.createElement('div')
    el.className = `liveui-conv-msg liveui-conv-msg--${role}`
    const head = document.createElement('div')
    head.className = 'liveui-conv-role'
    head.textContent = header
    if (hint) {
      const h = document.createElement('span')
      h.className = 'liveui-conv-hint'
      h.textContent = hint
      head.appendChild(h)
    }
    const body = document.createElement('div')
    body.className = 'liveui-conv-body liveui-md-root'
    body.innerHTML = html
    el.append(head, body)
    return el
  }

  const render = (): void => {
    if (!root) return
    const stick = isNearBottom()
    const frag = document.createDocumentFragment()

    for (const m of state.messages) {
      if (m.role === 'user') {
        const hint = m.attachments ? `（含 ${m.attachments} 个附件）` : undefined
        frag.appendChild(msgEl('user', '你', md(m.content), hint))
      } else if (m.role === 'assistant') {
        const hint = m.tools?.length ? `工具：${m.tools.join('、')}` : undefined
        frag.appendChild(msgEl('assistant', '助手', md(m.content), hint))
      } else {
        frag.appendChild(msgEl('tool', `工具 · ${m.name}`, md(m.content)))
      }
    }

    if (state.thinking.trim()) {
      frag.appendChild(msgEl('thinking', '💭 思考中', md(state.thinking)))
    }
    if (state.stream.trim()) {
      frag.appendChild(msgEl('stream', '助手 · 流式', md(state.stream)))
    }
    if (state.notice && state.notice.trim()) {
      frag.appendChild(msgEl('notice', '提示', md(state.notice)))
    }
    if (state.error && state.error.trim()) {
      frag.appendChild(msgEl('error', '错误', md(state.error)))
    }
    if (state.busy && state.statusLine && state.statusLine.trim()) {
      const el = document.createElement('div')
      el.className = 'liveui-conv-status'
      el.textContent = state.statusLine
      frag.appendChild(el)
    }
    if (!state.sessionReady) {
      const el = document.createElement('div')
      el.className = 'liveui-conv-status'
      el.textContent = '正在加载会话…'
      frag.appendChild(el)
    }

    root.replaceChildren(frag)
    if (stick) root.scrollTop = root.scrollHeight
  }

  const apply = (patch: LiveUiTuiView): void => {
    if (patch.messages !== undefined) state.messages = patch.messages
    if (patch.stream !== undefined) state.stream = patch.stream
    if (patch.thinking !== undefined) state.thinking = patch.thinking
    if (patch.error !== undefined) state.error = patch.error
    if (patch.notice !== undefined) state.notice = patch.notice
    if (patch.statusLine !== undefined) state.statusLine = patch.statusLine
    if (patch.busy !== undefined) state.busy = patch.busy
    if (patch.sessionReady !== undefined) state.sessionReady = patch.sessionReady
    render()
  }

  render()
  return { apply }
}
