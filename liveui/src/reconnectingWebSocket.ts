/**
 * ReconnectingWebSocket
 * --------------------------------------------------------------
 * 包装一个原生 WebSocket，对外提供与之兼容的最小接口
 * (`send` / `close` / `readyState` / `addEventListener` /
 * `removeEventListener`)，内部在底层连接断开后自动以指数退避
 * 方式重连，并在系统从休眠 / 网络断开 / 页面隐藏中恢复时立即
 * 触发一次重连尝试。
 *
 * 设计目标：
 *   - 调用方（main.ts、configPanel.ts）无需改动，原有
 *     `socket.send / socket.readyState / socket.addEventListener`
 *     等使用方式保持完全一致。
 *   - 重连成功后会重新派发 `open` 事件，调用方注册的 open
 *     处理器会被再次执行，从而恢复客户端→服务端的初始化逻辑。
 */

type EvType = 'open' | 'close' | 'error' | 'message'
type Listener = (ev: any) => void

export const MIN_BACKOFF_MS = 500
export const MAX_BACKOFF_MS = 10_000
export const BACKOFF_JITTER_MS = 250
const HEARTBEAT_INTERVAL_MS = 20_000

export type ReconnectBackoffOptions = {
  minMs?: number
  maxMs?: number
  jitterMs?: number
  random?: () => number
}

export function computeReconnectDelay(
  attempts: number,
  opts: ReconnectBackoffOptions = {},
): number {
  const minMs = opts.minMs ?? MIN_BACKOFF_MS
  const maxMs = opts.maxMs ?? MAX_BACKOFF_MS
  const jitterMs = opts.jitterMs ?? BACKOFF_JITTER_MS
  const random = opts.random ?? Math.random
  const safeAttempts = Math.max(0, Math.floor(attempts))
  const base = Math.min(maxMs, minMs * Math.pow(2, safeAttempts))
  return base + Math.floor(random() * jitterMs)
}

export class ReconnectingWebSocket {
  private readonly url: string
  private ws: WebSocket | null = null
  private readonly listeners: Record<EvType, Set<Listener>> = {
    open: new Set(),
    close: new Set(),
    error: new Set(),
    message: new Set(),
  }
  private reconnectAttempts = 0
  private reconnectTimer: number | undefined
  private heartbeatTimer: number | undefined
  private explicitlyClosed = false

  constructor(url: string) {
    this.url = url
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onWake)
      window.addEventListener('pageshow', this.onWake)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility)
    }
    this.connect()
  }

  /** 与原生 WebSocket.readyState 行为一致；底层 ws 缺失时返回 CLOSED。 */
  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data)
      } catch (err) {
        // 发送过程中底层连接异常 —— 立即触发重连，避免静默死链。
        console.warn('[liveui] WebSocket send 失败，准备重连', err)
        this.forceReconnect()
      }
    }
  }

  /** 显式关闭后不会再自动重连。 */
  close(): void {
    this.explicitlyClosed = true
    this.clearReconnectTimer()
    this.stopHeartbeat()
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onWake)
      window.removeEventListener('pageshow', this.onWake)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility)
    }
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
    }
  }

  addEventListener(type: EvType, listener: Listener): void {
    this.listeners[type].add(listener)
  }

  removeEventListener(type: EvType, listener: Listener): void {
    this.listeners[type].delete(listener)
  }

  // -----------------------------------------------------------
  // 内部实现
  // -----------------------------------------------------------

  private connect(): void {
    if (this.explicitlyClosed) return
    this.clearReconnectTimer()

    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      console.warn('[liveui] WebSocket 创建失败，将稍后重试', err)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', (ev) => {
      this.reconnectAttempts = 0
      this.startHeartbeat()
      this.dispatch('open', ev)
    })
    ws.addEventListener('close', (ev) => {
      this.stopHeartbeat()
      this.dispatch('close', ev)
      if (!this.explicitlyClosed) this.scheduleReconnect()
    })
    ws.addEventListener('error', (ev) => {
      this.dispatch('error', ev)
    })
    ws.addEventListener('message', (ev) => {
      this.dispatch('message', ev)
    })
  }

  private dispatch(type: EvType, ev: Event): void {
    for (const listener of this.listeners[type]) {
      try {
        listener(ev)
      } catch (err) {
        console.error(`[liveui] WebSocket "${type}" 监听器抛出异常`, err)
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.explicitlyClosed) return
    if (this.reconnectTimer != null) return
    const delay = computeReconnectDelay(this.reconnectAttempts)
    this.reconnectAttempts += 1
    console.debug(`[liveui] WebSocket 重连 #${this.reconnectAttempts} (${delay}ms 后)`)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  /** 系统从休眠 / 网络恢复 / 页面再可见时立即重连，跳过退避等待。 */
  private onWake = (): void => {
    if (this.explicitlyClosed) return
    if (this.readyState === WebSocket.OPEN) return
    this.forceReconnect()
  }

  private onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.onWake()
    }
  }

  private forceReconnect(): void {
    if (this.explicitlyClosed) return
    this.reconnectAttempts = 0
    this.clearReconnectTimer()
    this.stopHeartbeat()
    if (this.ws) {
      // 主动结束可能已死的旧连接，避免某些 OS 不发 close 导致僵尸。
      try { this.ws.close() } catch { /* ignore */ }
      // 如果旧 ws 处于 CONNECTING/CLOSING/CLOSED 不会发 close 事件再触发
      // scheduleReconnect，所以这里手动启动一次连接。
    }
    this.connect()
  }

  /**
   * 心跳兜底：周期性探测连接活性。服务端
   * `parseLiveUiClientMessage` 对未知 type 返回 null（静默忽略），
   * 因此 PING 不会被处理，但若底层连接已死，`send()` 会抛
   * 异常进而触发重连。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      try {
        this.ws.send(JSON.stringify({ type: 'PING' }))
      } catch (err) {
        console.warn('[liveui] WebSocket 心跳失败，准备重连', err)
        this.forceReconnect()
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer != null) {
      window.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }
}
