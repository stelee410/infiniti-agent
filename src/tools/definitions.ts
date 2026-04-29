export type JsonSchema = Record<string, unknown>

export type BuiltinToolName =
  | 'http_request'
  | 'bash'
  | 'update_memory'
  | 'memory'
  | 'user_profile'
  | 'search_sessions'
  | 'manage_skill'
  | 'knowledge_graph'
  | 'schedule'
  | 'snap_photo'
  | 'seedance_video'
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
          description: '整段超时毫秒（连接+读 body），默认 60000，最大 120000',
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
      '[已废弃，请用 memory 工具] 向长期记忆追加笔记。',
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
  {
    name: 'memory',
    description:
      '结构化长期记忆管理。支持 add（添加）、replace（替换）、remove（删除）、list（列出全部）四种操作。记忆有容量上限，满时需整合或替换旧条目。你应主动使用此工具保存：用户偏好与纠正、环境事实、项目约定、关键教训。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'list'],
          description: '操作类型',
        },
        id: {
          type: 'string',
          description: 'replace/remove 时必填：要操作的条目 ID',
        },
        title: {
          type: 'string',
          description: 'add/replace 时可选：短标题',
        },
        body: {
          type: 'string',
          description: 'add 时必填、replace 时可选：正文内容',
        },
        tag: {
          type: 'string',
          enum: ['fact', 'preference', 'lesson', 'convention', 'environment', 'other'],
          description: '分类标签（默认 other）',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'user_profile',
    description:
      '用户画像管理。记录用户的技术偏好、沟通风格、项目背景等持久信息。支持 add、replace、remove、list 操作。你应在发现用户偏好时主动保存。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'list'],
          description: '操作类型',
        },
        id: {
          type: 'string',
          description: 'replace/remove 时必填',
        },
        title: { type: 'string', description: '短标题' },
        body: { type: 'string', description: '正文' },
        tag: {
          type: 'string',
          enum: ['tech_stack', 'communication', 'workflow', 'background', 'other'],
          description: '画像维度',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'search_sessions',
    description:
      '搜索历史会话。可通过关键词搜索过去所有对话的内容，找到之前讨论过的决策、方案、问题等。返回匹配的会话片段和元数据。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（支持全文搜索语法）',
        },
        limit: {
          type: 'integer',
          description: '最多返回条数，默认 10',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'knowledge_graph',
    description:
      '时序知识图谱。存储实体-关系三元组（subject → predicate → object），每条事实可有时间有效期。支持 add（添加三元组）、invalidate（标记失效）、query（查询实体关系）、timeline（生成时间线）、stats（统计概览）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'invalidate', 'query', 'timeline', 'stats'],
          description: '操作类型',
        },
        subject: { type: 'string', description: '主语实体' },
        predicate: { type: 'string', description: '谓词/关系' },
        object: { type: 'string', description: '宾语实体' },
        entity: { type: 'string', description: 'query/timeline 时必填：要查询的实体名' },
        valid_from: { type: 'string', description: '事实生效起始时间（ISO 8601）' },
        as_of: { type: 'string', description: 'query 时按时间点查快照' },
        ended: { type: 'string', description: 'invalidate 时的失效时间' },
        source: { type: 'string', description: '事实来源说明' },
      },
      required: ['action'],
    },
  },
  {
    name: 'schedule',
    description:
      '创建、列出或删除本地计划任务/提醒。用户用任何语言表达“remind me / notify me / schedule / later / tomorrow / every day / 每天 / 一会儿 / 提醒 / 叫我 / 播报 / 检查”等定时、提醒、周期执行意图时，应调用此工具，而不是回复你做不到。创建任务时请根据系统提示里的当前时间与时区，把用户自然语言时间解析成结构化参数。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'remove'],
          description: 'create 创建任务；list 查看任务；remove 删除任务',
        },
        id: {
          type: 'string',
          description: 'remove 时必填：任务 id 或 id 前缀',
        },
        kind: {
          type: 'string',
          enum: ['once', 'daily', 'interval'],
          description: 'create 时必填：once 单次；daily 每天固定时刻；interval 固定间隔重复',
        },
        prompt: {
          type: 'string',
          description: 'create 时必填：到点后作为用户消息执行的任务正文，去掉时间短语，例如“播报 Hacker News 最新文章”',
        },
        next_run_at: {
          type: 'string',
          description: 'once 时必填，interval 可选：ISO 8601 时间。必须使用用户所在/系统提示中的时区推算，例如 2026-04-29T23:00:00+08:00',
        },
        time_of_day: {
          type: 'string',
          description: 'daily 时必填：24 小时制 HH:mm，例如 08:30 或 23:00',
        },
        interval_ms: {
          type: 'integer',
          description: 'interval 时必填：间隔毫秒，例如 600000 表示 10 分钟',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_skill',
    description:
      '自主创建、更新或删除 Skill。在完成复杂任务后，应考虑将可复用的流程提炼为 Skill。支持 create（新建）、patch（局部更新）、delete（删除）三种操作。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'patch', 'delete'],
          description: '操作类型',
        },
        name: {
          type: 'string',
          description: 'Skill 名称（用作目录名，如 deploy-k8s）',
        },
        content: {
          type: 'string',
          description: 'create 时必填：完整 SKILL.md 内容；patch 时为空',
        },
        old_string: {
          type: 'string',
          description: 'patch 时必填：要替换的原文片段',
        },
        new_string: {
          type: 'string',
          description: 'patch 时必填：替换为的新文本',
        },
      },
      required: ['action', 'name'],
    },
  },
  {
    name: 'snap_photo',
    description:
      '异步生成一张写实照片或合照，并把完成/失败邮件放进你的邮箱。适合用户想让你“生成照片、拍一张图、来张合照、把我们放到某个场景”等请求。此工具不会阻塞当前对话；调用后应自然告诉用户你已经去后台生成，完成后小信封会亮起。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: '图片内容提示词。用自然语言描述场景、人物、风格、光线、构图等。',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'seedance_video',
    description:
      '异步生成一个 Seedance / 火山方舟视频，并把完成/失败邮件放进你的邮箱。适合用户想让你“生成视频、做一段视频、用 Seedance 出片、把这个场景做成视频”等请求。如果用户当前消息带有拍照图片或上传图片，工具会自动把这些图片作为参考图传给视频 API。此工具不会阻塞当前对话；调用后应自然告诉用户你已经去后台生成，完成后小信封会亮起。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: '视频内容提示词。用自然语言描述场景、镜头运动、时长节奏、主体、风格、光线、音频要求等。',
        },
      },
      required: ['prompt'],
    },
  },
]
