import type { InfinitiConfig, McpServerConfig } from '../config/types.js'
import type { JsonSchema } from '../tools/definitions.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

export type AgentToolSpec = {
  name: string
  description: string
  parameters: JsonSchema
}

type Route = { server: string; originalName: string }

function sanitizeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'srv'
}

function buildMcpToolName(serverKey: string, toolName: string): string {
  const a = sanitizeKey(serverKey)
  const b = sanitizeKey(toolName)
  let n = `mcp__${a}__${b}`
  if (n.length > 64) {
    n = n.slice(0, 64)
  }
  return n
}

export class McpManager {
  private routes = new Map<string, Route>()

  private clients: Array<{ close: () => Promise<void> }> = []

  private clientByServer = new Map<string, Client>()

  private tools: AgentToolSpec[] = []

  async start(cfg: InfinitiConfig | null): Promise<void> {
    await this.stop()
    const servers = cfg?.mcp?.servers
    if (!servers || typeof servers !== 'object') {
      return
    }

    const { Client: McpClient } = await import(
      '@modelcontextprotocol/sdk/client/index.js'
    )
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    )

    for (const [serverId, sc] of Object.entries(servers)) {
      if (!sc || typeof sc !== 'object') {
        continue
      }
      const c = sc as McpServerConfig
      if (!c.command?.trim()) {
        continue
      }
      try {
        const mergedEnv: Record<string, string> = {}
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) {
            mergedEnv[k] = v
          }
        }
        if (c.env) {
          for (const [k, v] of Object.entries(c.env)) {
            if (v !== undefined) {
              mergedEnv[k] = v
            }
          }
        }
        const transport = new StdioClientTransport({
          command: c.command,
          args: c.args ?? [],
          env: mergedEnv,
          cwd: c.cwd,
        })
        const client = new McpClient({
          name: 'infiniti-agent',
          version: '0.0.1',
        })
        await client.connect(transport)
        this.clientByServer.set(serverId, client)
        this.clients.push({
          close: async () => {
            try {
              await transport.close()
            } catch {
              /* ignore */
            }
          },
        })
        const listed = await client.listTools()
        for (const t of listed.tools ?? []) {
          const exposed = buildMcpToolName(serverId, t.name)
          this.routes.set(exposed, {
            server: serverId,
            originalName: t.name,
          })
          const schema = (t.inputSchema ?? {
            type: 'object',
            properties: {},
          }) as JsonSchema
          this.tools.push({
            name: exposed,
            description: `[MCP ${serverId}] ${t.description ?? t.name}`,
            parameters: schema,
          })
        }
      } catch (e: unknown) {
        const err = e as Error
        process.stderr.write(
          `[mcp] 无法启动服务器 "${serverId}": ${err.message}\n`,
        )
      }
    }
  }

  async stop(): Promise<void> {
    for (const c of this.clients) {
      await c.close().catch(() => {})
    }
    this.clients = []
    this.clientByServer.clear()
    this.routes.clear()
    this.tools = []
  }

  getToolSpecs(): AgentToolSpec[] {
    return this.tools
  }

  async call(toolName: string, argsJson: string): Promise<string> {
    const route = this.routes.get(toolName)
    if (!route) {
      return JSON.stringify({ ok: false, error: '未知 MCP 工具' })
    }
    const client = this.clientByServer.get(route.server)
    if (!client) {
      return JSON.stringify({ ok: false, error: 'MCP 客户端不可用' })
    }
    let args: Record<string, unknown>
    try {
      args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    } catch {
      return JSON.stringify({ ok: false, error: '参数 JSON 无效' })
    }
    try {
      const out = await client.callTool({
        name: route.originalName,
        arguments: args,
      })
      const text = JSON.stringify(out.content ?? out, null, 2)
      return text.length > 200_000 ? `${text.slice(0, 200_000)}\n…(截断)` : text
    } catch (e: unknown) {
      const err = e as Error
      return JSON.stringify({ ok: false, error: err.message })
    }
  }
}
