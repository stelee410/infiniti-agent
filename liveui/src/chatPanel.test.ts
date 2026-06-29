// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { initChatPanel } from './chatPanel.ts'

function mountDom(): void {
  document.body.innerHTML = `
    <button id="liveui-btn-chat" aria-pressed="false"></button>
    <aside id="liveui-chat-panel" aria-hidden="true">
      <button id="liveui-chat-close"></button>
      <div id="liveui-chat-list"></div>
    </aside>
  `
  document.body.classList.remove('liveui-chat-open')
}

function list(): HTMLElement {
  return document.getElementById('liveui-chat-list') as HTMLElement
}

describe('initChatPanel', () => {
  beforeEach(() => mountDom())

  it('appends user messages and skips empty', () => {
    const panel = initChatPanel()
    panel.addUserMessage('你好')
    panel.addUserMessage('   ')
    const msgs = list().querySelectorAll('.liveui-chat-msg--user')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.textContent).toBe('你好')
  })

  it('streams one assistant bubble then finalizes', () => {
    const panel = initChatPanel()
    panel.beginAssistantStream()
    panel.updateAssistantStream('在')
    panel.updateAssistantStream('在的，我在')
    let bubbles = list().querySelectorAll('.liveui-chat-msg--assistant')
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]!.textContent).toContain('在的，我在')
    panel.endAssistantStream()
    // 下一轮应是新的气泡，而不是续写旧的。
    panel.beginAssistantStream()
    panel.updateAssistantStream('第二条')
    bubbles = list().querySelectorAll('.liveui-chat-msg--assistant')
    expect(bubbles).toHaveLength(2)
  })

  it('ignores empty assistant chunks (no empty bubble)', () => {
    const panel = initChatPanel()
    panel.beginAssistantStream()
    panel.updateAssistantStream('   ')
    expect(list().querySelectorAll('.liveui-chat-msg--assistant')).toHaveLength(0)
  })

  it('a new user message closes the current assistant stream', () => {
    const panel = initChatPanel()
    panel.beginAssistantStream()
    panel.updateAssistantStream('回复中')
    panel.addUserMessage('打断一下')
    panel.updateAssistantStream('继续')
    // “继续”应落到新气泡，而非追加进“回复中”。
    const bubbles = list().querySelectorAll('.liveui-chat-msg--assistant')
    expect(bubbles).toHaveLength(2)
  })

  it('toggle reflects open state on body/button/panel and onOpenChange fires', () => {
    const seen: boolean[] = []
    const panel = initChatPanel({ onOpenChange: (o) => seen.push(o) })
    expect(panel.isOpen()).toBe(false)
    panel.toggle()
    expect(panel.isOpen()).toBe(true)
    expect(document.body.classList.contains('liveui-chat-open')).toBe(true)
    expect(document.getElementById('liveui-btn-chat')!.getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById('liveui-chat-panel')!.getAttribute('aria-hidden')).toBe('false')
    panel.toggle(false)
    expect(panel.isOpen()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('close button collapses the panel', () => {
    const panel = initChatPanel()
    panel.toggle(true)
    ;(document.getElementById('liveui-chat-close') as HTMLButtonElement).click()
    expect(panel.isOpen()).toBe(false)
    expect(document.body.classList.contains('liveui-chat-open')).toBe(false)
  })
})
