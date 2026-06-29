/**
 * 把一次工具调用压成给「桌面伴侣 GUI 活动卡片」用的简短中文文案（GUI v0·B）。
 * 纯函数，便于单测；服务端在 dispatch 收口处调用，随 ACTIVITY 事件下发。
 */

const VERBS: Record<string, string> = {
  bash: '运行命令',
  read_file: '读取文件',
  list_directory: '浏览目录',
  glob_files: '查找文件',
  grep_files: '搜索内容',
  write_file: '写入文件',
  str_replace: '编辑文件',
  http_request: '访问网络',
  update_memory: '更新记忆',
  memory: '整理记忆',
  user_profile: '更新画像',
  search_sessions: '检索历史',
  knowledge_graph: '更新知识图谱',
  schedule: '安排日程',
  manage_skill: '管理技能',
  snap_photo: '生成图片',
  avatargen_real2d: '生成形象',
  seedance_video: '生成视频',
  send_image: '发送图片',
  send_video: '发送视频',
  send_file: '发送文件',
  screenshot: '截屏',
  create_h5_applet: '制作小应用',
  update_h5_applet: '更新小应用',
}

const DETAIL_KEYS = ['command', 'path', 'pattern', 'url', 'query', 'title', 'name', 'prompt']
const MAX_DETAIL = 60

export function activityVerb(tool: string): string {
  return VERBS[tool] ?? tool
}

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function activityDetail(argsJson: string): string {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return ''
  }
  if (!args || typeof args !== 'object') return ''
  for (const k of DETAIL_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return truncate(v, MAX_DETAIL)
  }
  return ''
}

export function summarizeToolActivity(tool: string, argsJson: string): string {
  const verb = activityVerb(tool)
  const detail = activityDetail(argsJson)
  return detail ? `${verb} · ${detail}` : verb
}
