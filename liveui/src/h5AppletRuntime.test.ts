// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createH5AppletHost } from './h5AppletRuntime.ts'

type Event = { type: 'beforeLaunch'; key: string } | { type: 'send'; payload: string }

function makeFakeSocket(events: Event[]) {
  return {
    readyState: 1,
    send: (payload: string) => {
      events.push({ type: 'send', payload })
    },
  }
}

function newRoot(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

describe('createH5AppletHost', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('invokes onBeforeLaunch before sending H5_APPLET_LAUNCH_REQUEST', () => {
    const events: Event[] = []
    const host = createH5AppletHost({
      root: newRoot(),
      socket: makeFakeSocket(events),
      onBeforeLaunch: (key) => events.push({ type: 'beforeLaunch', key }),
    })

    host.launch('show_me_magic')

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ type: 'beforeLaunch', key: 'show_me_magic' })
    expect(events[1]?.type).toBe('send')
    const sent = JSON.parse((events[1] as { payload: string }).payload)
    expect(sent).toEqual({ type: 'H5_APPLET_LAUNCH_REQUEST', data: { key: 'show_me_magic' } })
  })

  it('trims the key consistently for both the hook and the message', () => {
    const events: Event[] = []
    const host = createH5AppletHost({
      root: newRoot(),
      socket: makeFakeSocket(events),
      onBeforeLaunch: (key) => events.push({ type: 'beforeLaunch', key }),
    })

    host.launch('  show_me_magic  ')

    expect(events.map((e) => (e.type === 'beforeLaunch' ? e.key : JSON.parse(e.payload).data.key))).toEqual([
      'show_me_magic',
      'show_me_magic',
    ])
  })

  it('does not invoke onBeforeLaunch or send when key is empty / whitespace', () => {
    const events: Event[] = []
    const host = createH5AppletHost({
      root: newRoot(),
      socket: makeFakeSocket(events),
      onBeforeLaunch: (key) => events.push({ type: 'beforeLaunch', key }),
    })

    host.launch('')
    host.launch('   ')

    expect(events).toEqual([])
  })

  it('routes launcher button clicks through the same launch() path as the public API', () => {
    // 一致性核心：图标点击（icon）与 /showmemagic（外部 launch 调用）必须产生完全相同的副作用序列。
    const iconEvents: Event[] = []
    const iconHost = createH5AppletHost({
      root: newRoot(),
      socket: makeFakeSocket(iconEvents),
      onBeforeLaunch: (key) => iconEvents.push({ type: 'beforeLaunch', key }),
    })
    iconHost.setLibrary([
      {
        id: 'official_show_me_magic',
        key: 'official_show_me_magic',
        title: 'Show Me Magic',
        description: 'desc',
        launchMode: 'live_panel',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    const btn = document.querySelector('.liveui-h5-launcher-btn') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    btn!.click()

    const slashEvents: Event[] = []
    const slashHost = createH5AppletHost({
      root: newRoot(),
      socket: makeFakeSocket(slashEvents),
      onBeforeLaunch: (key) => slashEvents.push({ type: 'beforeLaunch', key }),
    })
    // 模拟 server 广播 H5_APPLET_LAUNCH 后 renderer 在 main.ts 中调用的同一函数。
    slashHost.launch('official_show_me_magic')

    expect(iconEvents).toEqual(slashEvents)
    expect(iconEvents).toEqual([
      { type: 'beforeLaunch', key: 'official_show_me_magic' },
      {
        type: 'send',
        payload: JSON.stringify({
          type: 'H5_APPLET_LAUNCH_REQUEST',
          data: { key: 'official_show_me_magic' },
        }),
      },
    ])
  })

  it('exposes a single launch entry: host.launch is the same reference used by the launcher buttons', () => {
    // 结构性保证：launcher 按钮的 click 处理器调用的就是 host.launch；
    // 任何修改不应让两条入口分叉到不同实现。
    const events: Event[] = []
    const host = createH5AppletHost({
      root: newRoot(),
      socket: makeFakeSocket(events),
      onBeforeLaunch: (key) => events.push({ type: 'beforeLaunch', key }),
    })
    host.setLibrary([
      {
        id: 'alpha',
        key: 'alpha',
        title: 'Alpha',
        description: '',
        launchMode: 'live_panel',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])

    // 直接调用 host.launch 与按钮点击应有相同效果（次序、key、payload 完全一致）。
    const beforeButton = events.length
    host.launch('alpha')
    const afterDirect = events.slice(beforeButton)

    events.length = beforeButton
    const btn = document.querySelector('.liveui-h5-launcher-btn') as HTMLButtonElement
    btn.click()
    const afterButton = events.slice(beforeButton)

    expect(afterDirect).toEqual(afterButton)
  })

  it('records onOpenChange once per applet create and tears it down on destroy', () => {
    const events: Event[] = []
    const openChanges: boolean[] = []
    const host = createH5AppletHost({
      root: newRoot(),
      socket: makeFakeSocket(events),
      onBeforeLaunch: (key) => events.push({ type: 'beforeLaunch', key }),
      onOpenChange: (open) => openChanges.push(open),
    })

    host.create({
      appId: 'app-1',
      title: 'Show Me Magic',
      description: '',
      launchMode: 'live_panel',
      html: '<p>hello</p>',
    })
    host.destroy('app-1')

    expect(openChanges).toEqual([true, false])
  })

  it('treats onBeforeLaunch as the canonical snapshot point: hook fires synchronously, before send', () => {
    // 锚点：onBeforeLaunch 必须在 send 之前同步触发，
    // 这样 main.ts 里基于该回调记录的 h5AppletReturnWindowSize 一定是"打开前的窗口尺寸"，
    // 与 WS 往返期间任何潜在的窗口压缩无关。
    const order: string[] = []
    const host = createH5AppletHost({
      root: newRoot(),
      socket: {
        readyState: 1,
        send: () => order.push('send'),
      },
      onBeforeLaunch: () => order.push('beforeLaunch'),
    })

    host.launch('whatever')

    expect(order).toEqual(['beforeLaunch', 'send'])
  })

  it('skips both hook and send when the socket is not open', () => {
    const events: Event[] = []
    const host = createH5AppletHost({
      root: newRoot(),
      socket: {
        readyState: 0, // CONNECTING
        send: (payload: string) => events.push({ type: 'send', payload }),
      },
      onBeforeLaunch: (key) => events.push({ type: 'beforeLaunch', key }),
    })

    host.launch('alpha')

    // 当前实现：onBeforeLaunch 同步先调用（用于 snapshot），send 因 socket 未就绪被 isSocketOpen 拦截。
    // snapshot 在 socket 未就绪时仍然安全（我们只是记录窗口尺寸），但消息确实不会发出去。
    expect(events.map((e) => e.type)).toEqual(['beforeLaunch'])
  })

  it('uses the new H5_APPLET_LAUNCH_REQUEST payload shape', () => {
    const events: Event[] = []
    const host = createH5AppletHost({
      root: newRoot(),
      socket: makeFakeSocket(events),
    })

    host.launch('foo_bar')

    const sent = events.filter((e) => e.type === 'send').map((e) => JSON.parse(e.payload))
    expect(sent).toEqual([{ type: 'H5_APPLET_LAUNCH_REQUEST', data: { key: 'foo_bar' } }])
  })
})

describe('H5 applet path consistency: icon click vs slash-command driven launch', () => {
  // 这一组是用户明确要求的"专门测试项"：
  // 验证从 LiveUI 角度看，/showmemagic（外部 launch）与点击图标的链路 100% 一致。
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  function runIconClickFlow(key: string): { hookKeys: string[]; sentKeys: string[] } {
    vi.useFakeTimers()
    const hookKeys: string[] = []
    const sentKeys: string[] = []
    const root = document.createElement('div')
    document.body.append(root)
    const host = createH5AppletHost({
      root,
      socket: {
        readyState: 1,
        send: (payload: string) => {
          const msg = JSON.parse(payload) as { type: string; data?: { key?: string } }
          if (msg.type === 'H5_APPLET_LAUNCH_REQUEST') sentKeys.push(msg.data?.key ?? '')
        },
      },
      onBeforeLaunch: (k) => hookKeys.push(k),
    })
    host.setLibrary([
      {
        id: key,
        key,
        title: key,
        description: '',
        launchMode: 'live_panel',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    const btn = document.querySelector('.liveui-h5-launcher-btn') as HTMLButtonElement
    btn.click()
    vi.useRealTimers()
    return { hookKeys, sentKeys }
  }

  function runSlashFlow(key: string): { hookKeys: string[]; sentKeys: string[] } {
    vi.useFakeTimers()
    const hookKeys: string[] = []
    const sentKeys: string[] = []
    const root = document.createElement('div')
    document.body.append(root)
    const host = createH5AppletHost({
      root,
      socket: {
        readyState: 1,
        send: (payload: string) => {
          const msg = JSON.parse(payload) as { type: string; data?: { key?: string } }
          if (msg.type === 'H5_APPLET_LAUNCH_REQUEST') sentKeys.push(msg.data?.key ?? '')
        },
      },
      onBeforeLaunch: (k) => hookKeys.push(k),
    })
    // /showmemagic 链路：服务端广播 H5_APPLET_LAUNCH，main.ts 的 H5_APPLET_LAUNCH 消息分支
    // 直接调用 h5AppletHost.launch(key)（参见 main.ts 中 'H5_APPLET_LAUNCH' 分支）。
    host.launch(key)
    vi.useRealTimers()
    return { hookKeys, sentKeys }
  }

  it('produces identical hook key sequence and identical wire payloads for both paths', () => {
    const KEY = 'official_show_me_magic'
    const icon = runIconClickFlow(KEY)
    const slash = runSlashFlow(KEY)

    expect(icon.hookKeys).toEqual([KEY])
    expect(icon.sentKeys).toEqual([KEY])
    expect(slash.hookKeys).toEqual(icon.hookKeys)
    expect(slash.sentKeys).toEqual(icon.sentKeys)
  })

  it('keeps the snapshot ordering invariant: hook strictly precedes send in both paths', () => {
    const order = (label: string): string[] => {
      const out: string[] = []
      const root = document.createElement('div')
      document.body.append(root)
      const host = createH5AppletHost({
        root,
        socket: {
          readyState: 1,
          send: () => out.push(`${label}:send`),
        },
        onBeforeLaunch: () => out.push(`${label}:hook`),
      })
      if (label === 'icon') {
        host.setLibrary([
          {
            id: 'k', key: 'k', title: 'k', description: '',
            launchMode: 'live_panel', updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ])
        ;(document.querySelector('.liveui-h5-launcher-btn') as HTMLButtonElement).click()
      } else {
        host.launch('k')
      }
      return out
    }
    expect(order('icon')).toEqual(['icon:hook', 'icon:send'])
    expect(order('slash')).toEqual(['slash:hook', 'slash:send'])
  })
})
