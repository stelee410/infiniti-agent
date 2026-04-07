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
}

export function isLlmProvider(v: string): v is LlmProvider {
  return v === 'anthropic' || v === 'openai' || v === 'gemini'
}
