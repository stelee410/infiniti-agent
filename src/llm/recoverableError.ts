/**
 * 判断 LLM 调用错误是否「值得在压缩会话后重试」。
 *
 * 触发条件：HTTP 5xx、408（请求超时）、413（payload 过大）、429（限流）、
 * 错误信息包含 context length / too long / max token，或者底层 Node 错误码
 * ETIMEDOUT / ECONNRESET / ECONNREFUSED。
 *
 * 这些情况通常是上游对当前请求不满（context 太大、上游服务抖动等），
 * 压缩历史后再试有意义；4xx 其它则不可重试。
 */
export function isRecoverableUpstreamError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const err = e as { status?: number; statusCode?: number; code?: string; message?: string }
  const status = typeof err.status === 'number'
    ? err.status
    : typeof err.statusCode === 'number'
      ? err.statusCode
      : 0
  if (status >= 500) return true
  if (status === 408 || status === 413 || status === 429) return true
  const msg = typeof err.message === 'string' ? err.message : ''
  if (/context.length|too.long|max.token|maximum.context/i.test(msg)) return true
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') return true
  return false
}
