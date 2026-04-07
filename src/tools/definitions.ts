export type JsonSchema = Record<string, unknown>

export type BuiltinToolName =
  | 'http_request'
  | 'bash'
  | 'update_memory'
  | 'read_file'
  | 'glob_files'
  | 'grep_files'
  | 'write_file'
  | 'str_replace'
  | 'list_directory'

export const BUILTIN_TOOLS: Array<{
  name: BuiltinToolName
  description: string
  parameters: JsonSchema
}> = [
  {
    name: 'read_file',
    description:
      '读取工作区内的文本文件。大文件请用 start_line/end_line（1-based，含首尾行）分段读取。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '相对会话 cwd 的路径' },
        start_line: {
          type: 'integer',
          description: '起始行号（从 1 计）。指定后未给 end_line 时默认读 1000 行',
        },
        end_line: {
          type: 'integer',
          description: '结束行号（含），可选',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description:
      '列出工作区内某目录的直接子项（名称与类型），用于浏览仓库结构。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: '目录路径，默认 "."',
        },
      },
      required: [],
    },
  },
  {
    name: 'glob_files',
    description:
      '按 glob 模式枚举工作区内文件路径（默认忽略 node_modules、.git、dist）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: {
          type: 'string',
          description: '例如 **/*.ts、src/**/*.tsx',
        },
        dot: {
          type: 'boolean',
          description: '是否匹配以 . 开头的文件，默认 false',
        },
        only_files: {
          type: 'boolean',
          description: '仅文件，默认 true',
        },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: '额外 ignore glob，可选',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep_files',
    description:
      '在工作区内按 path_glob 筛选文件，对每行做正则匹配（跳过大二进制）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: {
          type: 'string',
          description: 'JavaScript 正则表达式（不要包 //）',
        },
        path_glob: {
          type: 'string',
          description: '要搜索的文件范围，默认 **/*',
        },
        case_insensitive: {
          type: 'boolean',
          description: '等价于 /i',
        },
        max_matches: {
          type: 'integer',
          description: '最多返回匹配条数，默认 120',
        },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: '额外 ignore glob',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    description:
      '写入或覆盖工作区内文本文件；自动创建父目录。适合新建文件或整文件替换。大改动前可先设 dry_run=true 仅返回 unified diff 预览（不写入、不触发确认）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '相对会话 cwd 的路径' },
        content: { type: 'string', description: '完整文件 UTF-8 内容' },
        dry_run: {
          type: 'boolean',
          description: '为 true 时不写入，仅返回 ok + diff 预览',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'str_replace',
    description:
      '在单个文件内将 old_string 替换为 new_string。默认要求 old_string 唯一出现一次；可设 replace_all。可先 dry_run=true 仅返回 diff 预览。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '相对会话 cwd 的路径' },
        old_string: {
          type: 'string',
          description: '须与文件内容完全一致（含缩进与换行）',
        },
        new_string: { type: 'string', description: '替换为' },
        replace_all: {
          type: 'boolean',
          description: '为 true 时替换所有出现次数',
        },
        dry_run: {
          type: 'boolean',
          description: '为 true 时不写入，仅返回 ok + diff 预览',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
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
