import type {
  Real2dAudioChunk,
  Real2dFrame,
  Real2dHealth,
  Real2dParamUpdate,
  Real2dStartRequest,
  Real2dStartResponse,
} from './protocol.js'

export type Real2dClientOptions = {
  baseUrl?: string
  timeoutMs?: number
}

export class Real2dClient {
  readonly baseUrl: string
  readonly timeoutMs: number

  constructor(opts: Real2dClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? 'http://127.0.0.1:8921')
    this.timeoutMs = opts.timeoutMs ?? 2500
  }

  async health(): Promise<Real2dHealth> {
    return this.request<Real2dHealth>('GET', '/health')
  }

  async startSession(req: Real2dStartRequest): Promise<Real2dStartResponse> {
    return this.request<Real2dStartResponse>('POST', '/session/start', req)
  }

  async updateParams(update: Real2dParamUpdate): Promise<Real2dFrame | undefined> {
    return this.request<Real2dFrame | undefined>('POST', '/session/params', update)
  }

  async sendAudio(chunk: Real2dAudioChunk): Promise<void> {
    await this.request<unknown>('POST', '/session/audio', chunk)
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request<unknown>('POST', '/session/stop', { sessionId })
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: ctrl.signal,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`${method} ${path} failed: ${res.status}${text ? ` ${text.slice(0, 240)}` : ''}`)
      }
      if (res.status === 204) return undefined as T
      const text = await res.text()
      return (text ? JSON.parse(text) : undefined) as T
    } finally {
      clearTimeout(timer)
    }
  }
}

function normalizeBaseUrl(raw: string): string {
  const s = raw.trim() || 'http://127.0.0.1:8921'
  return s.endsWith('/') ? s.slice(0, -1) : s
}
