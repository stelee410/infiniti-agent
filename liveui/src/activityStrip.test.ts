// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initActivityStrip } from './activityStrip.ts'

function mountDom(): void {
  document.body.innerHTML = `
    <div id="liveui-activity-strip" hidden>
      <button id="liveui-activity-strip-main" hidden>
        <span id="liveui-activity-strip-icon"></span>
        <span id="liveui-activity-strip-text"></span>
      </button>
      <div id="liveui-activity-strip-approvals"></div>
    </div>
  `
}

function strip(): HTMLElement {
  return document.getElementById('liveui-activity-strip') as HTMLElement
}
function main(): HTMLElement {
  return document.getElementById('liveui-activity-strip-main') as HTMLElement
}

let hideFn: (() => void) | null
function newStrip(over: Partial<Parameters<typeof initActivityStrip>[0]> = {}) {
  hideFn = null
  return initActivityStrip({
    onExpand: vi.fn(),
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    setHideTimer: (fn) => {
      hideFn = fn
      return 1
    },
    clearHideTimer: () => {
      hideFn = null
    },
    ...over,
  })
}

describe('initActivityStrip', () => {
  beforeEach(() => mountDom())

  it('shows on activity start, then auto-hides after all done', () => {
    const s = newStrip()
    s.onActivity({ id: 'a1', tool: 'bash', status: 'start', summary: '运行命令 · ls' })
    expect(strip().hidden).toBe(false)
    expect(main().hidden).toBe(false)
    expect(strip().dataset.status).toBe('start')
    expect(document.getElementById('liveui-activity-strip-text')!.textContent).toBe('运行命令 · ls')

    s.onActivity({ id: 'a1', tool: 'bash', status: 'done', summary: '运行命令 · ls' })
    expect(strip().dataset.status).toBe('done')
    expect(typeof hideFn).toBe('function')
    hideFn!() // 模拟自愈定时器到点
    expect(strip().hidden).toBe(true)
  })

  it('keeps showing while another activity is still active', () => {
    const s = newStrip()
    s.onActivity({ id: 'a1', tool: 'bash', status: 'start', summary: 'x' })
    s.onActivity({ id: 'a2', tool: 'read_file', status: 'start', summary: 'y' })
    s.onActivity({ id: 'a1', tool: 'bash', status: 'done', summary: 'x' })
    // 仍有 a2 在跑，不应安排隐藏
    expect(hideFn).toBeNull()
    expect(strip().hidden).toBe(false)
    expect(strip().dataset.status).toBe('start')
  })

  it('expand fires when the activity line is clicked', () => {
    const onExpand = vi.fn()
    const s = newStrip({ onExpand })
    s.onActivity({ id: 'a1', tool: 'bash', status: 'start', summary: 'x' })
    main().click()
    expect(onExpand).toHaveBeenCalledOnce()
  })

  it('approval renders buttons; approve resolves and removes the card', () => {
    const onApprove = vi.fn()
    const s = newStrip({ onApprove })
    s.onApproval({ id: 'p1', tool: 'bash', summary: '运行命令 · rm x' })
    expect(strip().hidden).toBe(false)
    const card = document.querySelector('.liveui-approval')
    expect(card).not.toBeNull()
    expect(card!.querySelector('.liveui-approval-text')!.textContent).toContain('rm x')
    ;(card!.querySelector('.liveui-approval-btn--ok') as HTMLButtonElement).click()
    expect(onApprove).toHaveBeenCalledWith('p1')
    expect(document.querySelector('.liveui-approval')).toBeNull()
    expect(strip().hidden).toBe(true)
  })

  it('deny resolves with the deny callback', () => {
    const onDeny = vi.fn()
    const s = newStrip({ onDeny })
    s.onApproval({ id: 'p1', tool: 'bash', summary: 'x' })
    ;(document.querySelector('.liveui-approval-btn--no') as HTMLButtonElement).click()
    expect(onDeny).toHaveBeenCalledWith('p1')
  })

  it('when drawer is open the activity line is suppressed but approvals remain', () => {
    const s = newStrip()
    s.onActivity({ id: 'a1', tool: 'bash', status: 'start', summary: 'x' })
    s.setDrawerOpen(true)
    expect(main().hidden).toBe(true)
    expect(strip().hidden).toBe(true)
    s.onApproval({ id: 'p1', tool: 'bash', summary: 'y' })
    // 审批始终就地呈现，即便抽屉开着
    expect(strip().hidden).toBe(false)
    expect(document.querySelector('.liveui-approval')).not.toBeNull()
  })
})
