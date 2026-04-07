/** 把 SDK / 网络错误整理成 TUI 里可读的一行说明 */
export function formatChatError(e: unknown): string {
  if (e instanceof Error) {
    const any = e as Error & {
      status?: number
      error?: { message?: string; type?: string }
    }
    const nested = any.error?.message
    const typ = any.error?.type
    const status = any.status
    const bits = [any.message]
    if (typ) {
      bits.push(`type=${typ}`)
    }
    if (nested && nested !== any.message) {
      bits.push(nested)
    }
    if (status) {
      bits.push(`HTTP ${status}`)
    }
    return bits.filter(Boolean).join(' — ')
  }
  return String(e)
}
