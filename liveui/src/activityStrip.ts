/**
 * 自适应活动条（桌面伴侣 GUI v0.5）。
 *
 * 解决"精灵模式：复杂任务不够用、简单任务又冗余"的张力——按需披露：
 * - 无操作：完全隐藏，纯精灵。
 * - 有工具在跑：形象旁浮出一行轻量活动，瞄一眼即可；全部完成后自愈消失。
 * - 复杂任务：点活动行一键展开抽屉看全量。
 * - 需要确认：就地弹「允许 / 拒绝」按钮，一键放行（复用对话式审批）。
 * 在普通模式与极简（精灵）模式下都工作。
 */

export type ActivityStripHandle = {
  onActivity(data: { id: string; tool: string; status: 'start' | 'done' | 'error'; summary?: string }): void
  onApproval(data: { id: string; tool: string; summary?: string }): void
  /** 抽屉开关状态：抽屉已展开时，活动行交给抽屉，活动条只保留待确认项。 */
  setDrawerOpen(open: boolean): void
}

const HIDE_DELAY_MS = 2600
const ACTIVITY_ICON: Record<string, string> = { start: '○', done: '✓', error: '✕' }

export function initActivityStrip(opts: {
  onExpand: () => void
  onApprove: (id: string) => void
  onDeny: (id: string) => void
  setHideTimer?: (fn: () => void, ms: number) => number
  clearHideTimer?: (h: number) => void
}): ActivityStripHandle {
  const strip = document.getElementById('liveui-activity-strip')
  const mainEl = document.getElementById('liveui-activity-strip-main')
  const iconEl = document.getElementById('liveui-activity-strip-icon')
  const textEl = document.getElementById('liveui-activity-strip-text')
  const approvalsEl = document.getElementById('liveui-activity-strip-approvals')

  const setTimer = opts.setHideTimer ?? ((fn, ms) => window.setTimeout(fn, ms))
  const clearTimer = opts.clearHideTimer ?? ((h) => window.clearTimeout(h))

  const activeIds = new Set<string>()
  const approvals = new Map<string, { tool: string; summary: string }>()
  let last: { summary: string; status: 'start' | 'done' | 'error' } | null = null
  let recentVisible = false
  let drawerOpen = false
  let hideTimer: number | undefined

  const cancelHide = (): void => {
    if (hideTimer !== undefined) {
      clearTimer(hideTimer)
      hideTimer = undefined
    }
  }

  const scheduleHide = (): void => {
    cancelHide()
    hideTimer = setTimer(() => {
      hideTimer = undefined
      recentVisible = false
      last = null
      render()
    }, HIDE_DELAY_MS)
  }

  const renderApprovals = (): void => {
    if (!approvalsEl) return
    approvalsEl.replaceChildren()
    for (const [id, info] of approvals) {
      const card = document.createElement('div')
      card.className = 'liveui-approval'
      const text = document.createElement('span')
      text.className = 'liveui-approval-text'
      text.textContent = `需要确认：${info.summary || info.tool}`
      const actions = document.createElement('div')
      actions.className = 'liveui-approval-actions'
      const approve = document.createElement('button')
      approve.type = 'button'
      approve.className = 'liveui-approval-btn liveui-approval-btn--ok'
      approve.textContent = '允许'
      approve.addEventListener('click', () => {
        approvals.delete(id)
        opts.onApprove(id)
        render()
      })
      const deny = document.createElement('button')
      deny.type = 'button'
      deny.className = 'liveui-approval-btn liveui-approval-btn--no'
      deny.textContent = '拒绝'
      deny.addEventListener('click', () => {
        approvals.delete(id)
        opts.onDeny(id)
        render()
      })
      actions.append(approve, deny)
      card.append(text, actions)
      approvalsEl.appendChild(card)
    }
  }

  const render = (): void => {
    if (!strip) return
    renderApprovals()
    const showMain = !drawerOpen && (activeIds.size > 0 || recentVisible) && !!last
    if (mainEl) {
      mainEl.hidden = !showMain
      if (showMain && last) {
        const status = activeIds.size > 0 ? 'start' : last.status
        strip.dataset.status = status
        if (iconEl) iconEl.textContent = ACTIVITY_ICON[status] ?? '○'
        if (textEl) textEl.textContent = last.summary
      }
    }
    const hasApproval = approvals.size > 0
    strip.hidden = !(hasApproval || showMain)
  }

  const onActivity: ActivityStripHandle['onActivity'] = (data) => {
    const summary = (data.summary || data.tool || '').trim()
    if (!summary && data.status === 'start') return
    if (data.status === 'start') {
      activeIds.add(data.id)
      cancelHide()
      recentVisible = true
      if (summary) last = { summary, status: 'start' }
    } else {
      activeIds.delete(data.id)
      if (summary) last = { summary, status: data.status }
      recentVisible = true
      if (activeIds.size === 0) scheduleHide()
    }
    render()
  }

  const onApproval: ActivityStripHandle['onApproval'] = (data) => {
    approvals.set(data.id, { tool: data.tool, summary: (data.summary || '').trim() })
    cancelHide()
    renderApprovals()
    render()
  }

  const setDrawerOpen = (open: boolean): void => {
    drawerOpen = open
    render()
  }

  mainEl?.addEventListener('click', () => opts.onExpand())
  renderApprovals()
  render()

  return { onActivity, onApproval, setDrawerOpen }
}
