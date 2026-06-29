// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { initTuiView } from './tuiView.ts'

function mount(): void {
  document.body.innerHTML = `<div id="liveui-conversation-list"></div>`
}
function list(): HTMLElement {
  return document.getElementById('liveui-conversation-list') as HTMLElement
}
function newView() {
  return initTuiView({ strip: (s) => s })
}

describe('initTuiView', () => {
  beforeEach(() => mount())

  it('renders user/assistant/tool messages with roles', () => {
    const v = newView()
    v.apply({
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '在的', tools: ['bash'] },
        { role: 'tool', name: 'bash', content: 'ok' },
      ],
    })
    const msgs = list().querySelectorAll('.liveui-conv-msg')
    expect(msgs).toHaveLength(3)
    expect(list().querySelector('.liveui-conv-msg--user .liveui-conv-body')!.textContent).toContain('你好')
    expect(list().querySelector('.liveui-conv-msg--assistant .liveui-conv-hint')!.textContent).toContain('bash')
    expect(list().querySelector('.liveui-conv-msg--tool .liveui-conv-role')!.textContent).toContain('bash')
  })

  it('merges transient state without dropping messages', () => {
    const v = newView()
    v.apply({ messages: [{ role: 'user', content: 'hi' }] })
    v.apply({ stream: '正在回答…', busy: true })
    expect(list().querySelectorAll('.liveui-conv-msg--user')).toHaveLength(1)
    expect(list().querySelector('.liveui-conv-msg--stream')!.textContent).toContain('正在回答')
  })

  it('shows error and thinking boxes', () => {
    const v = newView()
    v.apply({ error: '出错了', thinking: '让我想想' })
    expect(list().querySelector('.liveui-conv-msg--error')!.textContent).toContain('出错了')
    expect(list().querySelector('.liveui-conv-msg--thinking')!.textContent).toContain('让我想想')
  })

  it('clears stream when emptied', () => {
    const v = newView()
    v.apply({ stream: 'x' })
    expect(list().querySelector('.liveui-conv-msg--stream')).not.toBeNull()
    v.apply({ stream: '' })
    expect(list().querySelector('.liveui-conv-msg--stream')).toBeNull()
  })

  it('shows status line only while busy', () => {
    const v = newView()
    v.apply({ statusLine: '执行中…', busy: false })
    expect(list().querySelector('.liveui-conv-status')).toBeNull()
    v.apply({ busy: true })
    expect(list().querySelector('.liveui-conv-status')!.textContent).toContain('执行中')
  })

  it('applies the strip callback to content', () => {
    const v = initTuiView({ strip: (s) => s.replace('SECRET', '甜豆') })
    v.apply({ messages: [{ role: 'assistant', content: '你好 SECRET' }] })
    const body = list().querySelector('.liveui-conv-msg--assistant .liveui-conv-body')!.textContent ?? ''
    expect(body).toContain('甜豆')
    expect(body).not.toContain('SECRET')
  })
})
