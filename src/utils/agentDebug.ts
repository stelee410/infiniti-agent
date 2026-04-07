/**
 * 排障：终端前加环境变量 `INFINITI_AGENT_DEBUG=1` 可在 stderr 看到 loop / 工具阶段日志。
 */
export function agentDebug(...parts: unknown[]): void {
  if (!process.env.INFINITI_AGENT_DEBUG?.trim()) {
    return
  }
  const msg = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')
  console.error(`[infiniti-agent ${new Date().toISOString()}] ${msg}`)
}
