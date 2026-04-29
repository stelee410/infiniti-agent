import type { InfinitiConfig } from '../config/types.js'
import type { PersistedMessage } from './persisted.js'
import { oneShotTextCompletion } from './oneShotCompletion.js'
import { agentDebug } from '../utils/agentDebug.js'

export type GateDecision =
  | { decision: 'approve' }
  | { decision: 'ask'; reason: string }
  | { decision: 'deny'; reason: string }

// ── Level 0: 只读工具 → 瞬间放行 ──

const ALWAYS_SAFE = new Set([
  'read_file',
  'list_directory',
  'grep_files',
  'glob_files',
  'file_info',
  'search_files',
  'read_notebook_cell',
  'snap_photo',
  'seedance_video',
])

// ── 上下文感知：用户在前轮 block 后明确批准 → 放行 ──

const APPROVAL_RE = /确[定认]|执行|可以|允许|好[的]?|同意|没问题|是[的]?|对|嗯|go\s*ahead|yes|sure|do\s*it|proceed|approve|ok|行|没事|放行|继续/i

function userApprovedAfterBlock(messages: PersistedMessage[]): boolean {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') { lastUserIdx = i; break }
  }
  if (lastUserIdx < 0) return false

  const lastUser = messages[lastUserIdx] as Extract<PersistedMessage, { role: 'user' }>
  if (!APPROVAL_RE.test(lastUser.content)) return false

  for (let j = lastUserIdx - 1; j >= Math.max(0, lastUserIdx - 10); j--) {
    const m = messages[j]!
    if (m.role === 'tool' && m.content.includes('"status":"blocked"')) {
      return true
    }
  }
  return false
}

// ── Level 1: 规则引擎 ──

const SAFE_BASH_RE = /^\s*(ls|cat|head|tail|echo|printf|pwd|which|whoami|date|cal|uname|env|printenv|hostname|id|groups|locale|tree|file|type|man|wc|sort|uniq|diff|md5|sha\w*sum|base64|stat|du|df|free|uptime|ps|top|htop|lsof|nproc|arch|sysctl|sw_vers|system_profiler|xcode-select|brew\s+(list|info|--version)|git\s+(status|log|diff|branch|tag|show|remote|rev-parse|describe|stash\s+list|config\s+--get)|npm\s+(list|ls|--version|outdated|info|view|pack|run\s+lint|run\s+test|run\s+build|run\s+dev|run\s+start)|npx\s|node\s+(--version|-e|-p)|python[23]?\s+(--version|-c)|pip[23]?\s+(list|show|freeze)|cargo\s+(--version|check|clippy|fmt|test)|rustc\s+--version|go\s+(version|list|vet)|java\s+--version|javac\s+--version|ruby\s+--version|find\s|grep\s|rg\s|ag\s|fd\s|fzf|jq\s|yq\s|curl\s.*--head|curl\s+-I|ping\s+-c|dig\s|nslookup\s|host\s|traceroute\s|ifconfig|ip\s+(addr|link|route)|netstat|ss\s|open\s|pbcopy|pbpaste|say\s|tput\s|clear|reset|mkdir\s|touch\s|cp\s|mv\s|ln\s)(\s|$)/i

const DANGEROUS_BASH_RE = /rm\s+(-\w*r\w*\s+)?\/(\s|$)|rm\s+-rf\s|mkfs|format\s+[A-Z]:|dd\s+if=|>\s*\/dev\/sd|shutdown|reboot|init\s+[06]|systemctl\s+(stop|disable|mask)|chmod\s+777\s+\/|chown\s+-R\s+.*\s+\/|curl\s+.*\|\s*(sudo\s+)?bash|wget\s+.*\|\s*(sudo\s+)?bash/i

const EDIT_INTENT_RE = /写|改|修改|创建|编辑|添加|更新|实现|重构|修复|删除|移除|替换|生成|优化|整理|fix|refactor|write|edit|create|update|add|implement|remove|replace|generate|build|make|set up|configure|install/i
const EXEC_INTENT_RE = /运行|执行|跑|命令|安装|编译|构建|部署|启动|停止|测试|打包|发布|推送|拉取|run|exec|install|compile|build|deploy|start|stop|test|package|publish|push|pull|commit|npm|pip|cargo|yarn|pnpm|docker|git|make/i
const HTTP_INTENT_RE = /api|请求|发送|访问|查询|获取|下载|上传|调用|fetch|request|query|search|天气|weather|翻译|translate|搜索/i

function userIntentAligns(messages: PersistedMessage[], pattern: RegExp): boolean {
  const userMsgs = messages
    .filter((m): m is Extract<PersistedMessage, { role: 'user' }> => m.role === 'user')
    .slice(-4)
  return userMsgs.some((m) => pattern.test(m.content))
}

function evaluateByRules(
  toolName: string,
  toolDetail: string,
  messages: PersistedMessage[],
): GateDecision | null {
  if (toolName === 'bash') {
    if (DANGEROUS_BASH_RE.test(toolDetail)) return { decision: 'ask', reason: '检测到潜在危险命令' }
    if (SAFE_BASH_RE.test(toolDetail)) return { decision: 'approve' }
    if (userIntentAligns(messages, EXEC_INTENT_RE)) return { decision: 'approve' }
    return null
  }

  if (toolName === 'http_request') {
    if (toolDetail.startsWith('GET ')) return { decision: 'approve' }
    if (userIntentAligns(messages, HTTP_INTENT_RE)) return { decision: 'approve' }
    return null
  }

  if (toolName === 'write_file' || toolName === 'str_replace') {
    if (userIntentAligns(messages, EDIT_INTENT_RE)) return { decision: 'approve' }
    return null
  }

  // MCP / 其他工具：用户主动配置 → 信任
  return { decision: 'approve' }
}

// ── Level 2: LLM 兜底 ──

const GATE_SYSTEM = `你是工具安全评估模块。根据工具名、详情和对话上下文判断安全级别。
只回复一个 JSON：
{"decision":"approve"} 或 {"decision":"ask","reason":"原因"} 或 {"decision":"deny","reason":"原因"}

approve：操作与用户意图一致或无害。
ask：有不可逆风险且无法确认用户意图。
deny：明显恶意。`

function summarizeMessages(messages: PersistedMessage[], max = 6): string {
  return messages.slice(-max)
    .map((m) => {
      if (m.role === 'user') return `[user] ${m.content.slice(0, 300)}`
      if (m.role === 'assistant') return `[assistant] ${(m.content ?? '').slice(0, 200)}`
      return `[tool·${m.name}] ${m.content.slice(0, 100)}`
    })
    .join('\n')
}

async function llmEvaluate(
  config: InfinitiConfig,
  toolName: string,
  toolDetail: string,
  messages: PersistedMessage[],
): Promise<GateDecision> {
  const context = summarizeMessages(messages)
  const userPrompt = `工具：${toolName}\n详情：${toolDetail.slice(0, 800)}\n\n对话：\n${context}`
  const primaryProfile = config.llm.metaAgentProfile?.trim() || 'gate'

  async function callGate(profile: string | undefined): Promise<GateDecision> {
    const raw = await oneShotTextCompletion({
      config,
      system: GATE_SYSTEM,
      user: userPrompt,
      maxOutTokens: 256,
      profile,
    })

    agentDebug('[meta-agent] llm raw:', profile ?? 'default', JSON.stringify(raw.slice(0, 300)))

    const jsonMatch = raw.match(/\{[^}]*"decision"\s*:\s*"[^"]+?"[^}]*\}/)
    if (!jsonMatch) {
      agentDebug('[meta-agent] no JSON, defaulting approve')
      return { decision: 'approve' }
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const decision = parsed.decision as string
    const reason = typeof parsed.reason === 'string' ? parsed.reason : ''

    if (decision === 'deny') return { decision: 'deny', reason: reason || '安全评估拒绝' }
    if (decision === 'ask') return { decision: 'ask', reason: reason || '需要确认' }
    return { decision: 'approve' }
  }

  agentDebug('[meta-agent] llm-evaluate', toolName, 'profile', primaryProfile)

  try {
    return await callGate(primaryProfile)
  } catch (e) {
    agentDebug('[meta-agent] primary llm failed, falling back to default', primaryProfile, e)
  }

  try {
    return await callGate(undefined)
  } catch (e) {
    agentDebug('[meta-agent] fallback llm failed, asking human', e)
    return {
      decision: 'ask',
      reason: 'meta-agent 与主 LLM 安全评估均失败，需要用户确认',
    }
  }
}

// ── 统一入口 ──

export async function evaluateToolSafety(
  config: InfinitiConfig,
  toolName: string,
  toolDetail: string,
  recentMessages: PersistedMessage[],
): Promise<GateDecision> {
  if (ALWAYS_SAFE.has(toolName)) {
    agentDebug('[meta-agent] L0 safe-tool', toolName)
    return { decision: 'approve' }
  }

  // 用户在前轮 block 后已明确批准 → 直接放行
  if (userApprovedAfterBlock(recentMessages)) {
    agentDebug('[meta-agent] user approved after block → approve', toolName)
    return { decision: 'approve' }
  }

  const ruleResult = evaluateByRules(toolName, toolDetail, recentMessages)
  if (ruleResult) {
    agentDebug('[meta-agent] L1 rule', toolName, ruleResult.decision, (ruleResult as { reason?: string }).reason ?? '')
    return ruleResult
  }

  return llmEvaluate(config, toolName, toolDetail, recentMessages)
}
