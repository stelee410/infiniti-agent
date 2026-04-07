export type JsonSchema = Record<string, unknown>

export type BuiltinToolName = 'http_request' | 'bash' | 'update_memory'

export const BUILTIN_TOOLS: Array<{
  name: BuiltinToolName
  description: string
  parameters: JsonSchema
}> = [
  {
    name: 'http_request',
    description:
      '发起 HTTP 请求（GET/POST/PUT/PATCH/DELETE）。用于抓取 URL、调用 REST API。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          description: 'HTTP 方法',
        },
        url: { type: 'string', description: '完整 URL，需含 http/https' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '可选请求头',
        },
        body: {
          type: 'string',
          description: '可选请求体（文本或 JSON 字符串）',
        },
        timeoutMs: {
          type: 'integer',
          description: '超时毫秒，默认 30000，最大 120000',
        },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'bash',
    description:
      '在本地 shell 执行命令。Unix/macOS 使用 bash -lc；Windows 使用 PowerShell。请谨慎使用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: '要执行的命令字符串' },
        cwd: {
          type: 'string',
          description: '工作目录，默认可省略（使用当前会话 cwd）',
        },
        timeoutMs: {
          type: 'integer',
          description: '超时毫秒，默认 120000',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'update_memory',
    description:
      '向全局长期记忆文件追加结构化笔记，供后续会话与自动 loop 使用。应写入高信号、可复用的事实。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '短标题，可选' },
        body: { type: 'string', description: '要追加的正文（Markdown）' },
      },
      required: ['body'],
    },
  },
]
