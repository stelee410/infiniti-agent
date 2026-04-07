export type LlmProvider = 'anthropic' | 'openai' | 'gemini'

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/**
 * ~/.infiniti-agent/config.json
 *
 * MCP 示例（可手动编辑，init 会保留已有 mcp/skills 段）：
 * `"mcp": { "servers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }`
 */
export type CompactionConfig = {
  /**
   * 估算 token 达到或超过此值时，在用户发话触发主循环前自动压缩历史（0 或未设置表示关闭）。
   * token 为粗估（约 4 字符 ≈ 1 token），仅统计 messages，不含 system。
   */
  autoThresholdTokens?: number
  /** 压缩后至少保留的尾部消息条数（保证工具链完整），默认 16 */
  minTailMessages?: number
  /** 写入摘要请求时，单条 tool 输出最多保留字符数，默认 4000 */
  maxToolSnippetChars?: number
  /**
   * Pre-compact 可执行文件路径（可相对 cwd）。
   * stdin：UTF-8 对话节选；stdout 非空时并入摘要提示（附加约束）。
   */
  preCompactHook?: string
}

export type InfinitiConfig = {
  version: 1
  llm: {
    provider: LlmProvider
    baseUrl: string
    model: string
    apiKey: string
  }
  skills?: {
    directories?: string[]
  }
  mcp?: {
    servers?: Record<string, McpServerConfig>
  }
  compaction?: CompactionConfig
}

export function isLlmProvider(v: string): v is LlmProvider {
  return v === 'anthropic' || v === 'openai' || v === 'gemini'
}
