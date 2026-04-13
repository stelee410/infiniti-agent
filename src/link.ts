import { readFile, writeFile, chmod } from 'fs/promises'
import { join } from 'path'

export interface SoulMailConfig {
  agentAddress: string
  agentId: string
  apiKey: string
}

/**
 * 从 SOUL.md 内容中提取邮件相关配置。
 * 识别模式：
 *   - agent address: xxx@xxx.amp.linkyun.co
 *   - agent id: UUID v4
 *   - api key: amk_xxx
 */
export function parseSoulMailConfig(content: string): SoulMailConfig {
  const addressMatch = content.match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.amp\.linkyun\.co/)
  const idMatch = content.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  const keyMatch = content.match(/amk_[A-Za-z0-9]+/)

  if (!addressMatch) throw new Error('SOUL.md 中未找到 agent 地址（格式：xxx@xxx.amp.linkyun.co）')
  if (!idMatch) throw new Error('SOUL.md 中未找到 agent ID（格式：UUID）')
  if (!keyMatch) throw new Error('SOUL.md 中未找到 API key（格式：amk_xxx）')

  return {
    agentAddress: addressMatch[0],
    agentId: idMatch[0],
    apiKey: keyMatch[0],
  }
}

function generateMailPollerScript(cfg: SoulMailConfig): string {
  return `#!/usr/bin/env bash
#
# mail-poller.sh — ama-pm 邮件轮询守护脚本
#
# 功能：每 60 秒检查一次 Mail Broker 收件箱，发现未读邮件时
#       直接调用 infiniti-agent cli，由 Agent 自行读取和处理邮件。
#
# 用法：
#   chmod +x mail-poller.sh
#   ./mail-poller.sh              # 前台运行（Ctrl-C 停止）
#   nohup ./mail-poller.sh &      # 后台运行
#   ./mail-poller.sh --once       # 仅检查一次后退出
#
# 日志：输出到当前目录 mail-poller.log，终端仅显示单行状态
#

set -euo pipefail

# ──────────────────────── 配置（从 SOUL.md 提取） ────────────────────────

AGENT_ADDRESS="${cfg.agentAddress}"
AGENT_ID="${cfg.agentId}"
API_KEY="${cfg.apiKey}"
BROKER_URL="https://amp.linkyun.co"

INBOX_URL="\${BROKER_URL}/messages/inbox/\${AGENT_ADDRESS}?agent_id=\${AGENT_ID}"

POLL_INTERVAL=60          # 秒
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="\${SCRIPT_DIR}/mail-poller.log"

# ──────────────────────── 统计 ────────────────────────

TOTAL_CHECKS=0
TOTAL_UNREAD=0
TOTAL_HANDLED=0

# ──────────────────────── 工具函数 ────────────────────────

# 写日志文件（不输出到终端）
log_file() {
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[\${ts}] $*" >> "\${LOG_FILE}"
}

# 终端单行状态更新（\\r 回到行首覆盖）
status_line() {
  echo -ne "\\r\\033[K$*"
}

# 打印完整行到终端+日志（用于启动信息和最终结果）
print() {
  echo -e "\\r\\033[K$*"
  log_file "$*"
}

# 调用 Mail Broker API（GET）
api_get() {
  curl -sS -H "X-API-Key: \${API_KEY}" "$1"
}

# ──────────────────────── 核心逻辑 ────────────────────────

check_and_handle() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

  status_line "🔍 [$(date '+%H:%M:%S')] 检查收件箱 ..."

  local response
  response="$(api_get "\${INBOX_URL}")" || {
    log_file "❌ 收件箱请求失败，跳过本轮"
    status_line "❌ [$(date '+%H:%M:%S')] 收件箱请求失败，\${POLL_INTERVAL}s 后重试 | 检查:\${TOTAL_CHECKS} 已处理:\${TOTAL_HANDLED}"
    return 1
  }

  # 统计未读邮件数量
  local count
  count="$(printf '%s' "\${response}" | python3 -c "
import json, sys
msgs = json.loads(sys.stdin.read())
if isinstance(msgs, list):
    print(sum(1 for m in msgs if m.get('is_read') == False))
else:
    print(0)
" 2>/dev/null || echo "0")"

  if [ "\${count}" -eq 0 ]; then
    log_file "📭 没有未读邮件"
    status_line "📭 [$(date '+%H:%M:%S')] 没有未读邮件 | 检查:\${TOTAL_CHECKS} 已处理:\${TOTAL_HANDLED}"
    return 0
  fi

  TOTAL_UNREAD=$((TOTAL_UNREAD + count))

  status_line "📬 [$(date '+%H:%M:%S')] 发现 \${count} 封未读邮件，调用 infiniti-agent 处理 ..."
  log_file "📬 发现 \${count} 封未读邮件，调用 infiniti-agent 处理 ..."

  # 直接调用 infiniti-agent，让它自行查收件箱、分析邮件、回复
  local prompt
  prompt="你收到了\${count}封未读邮件，请立即通过 Inbox API 查询收件箱 (GET \${INBOX_URL})，逐封阅读未读邮件并根据内容进行回复。处理完后标记已读。你的邮箱地址是 \${AGENT_ADDRESS}，Agent ID 是 \${AGENT_ID}。"

  if cd "\${SCRIPT_DIR}" && infiniti-agent cli "\${prompt}" >> "\${LOG_FILE}" 2>&1; then
    TOTAL_HANDLED=$((TOTAL_HANDLED + count))
    log_file "✅ infiniti-agent 处理完成"
    status_line "✅ [$(date '+%H:%M:%S')] 处理完成 \${count} 封 | 检查:\${TOTAL_CHECKS} 已处理:\${TOTAL_HANDLED}"
  else
    log_file "❌ infiniti-agent 处理失败（exit code: $?）"
    status_line "❌ [$(date '+%H:%M:%S')] 处理失败 | 检查:\${TOTAL_CHECKS} 已处理:\${TOTAL_HANDLED}"
  fi
}

# ──────────────────────── 退出清理 ────────────────────────

cleanup() {
  echo -e "\\r\\033[K🛑 ama-pm 邮件轮询已停止 | 总检查:\${TOTAL_CHECKS} 总未读:\${TOTAL_UNREAD} 总已处理:\${TOTAL_HANDLED}"
  log_file "🛑 邮件轮询已停止 | 总检查:\${TOTAL_CHECKS} 总未读:\${TOTAL_UNREAD} 总已处理:\${TOTAL_HANDLED}"
  exit 0
}
trap cleanup INT TERM

# ──────────────────────── 主循环 ────────────────────────

main() {
  # 启动信息（完整打印，不覆盖）
  print "🚀 ama-pm 邮件轮询守护进程启动"
  print "   地址: \${AGENT_ADDRESS}"
  print "   轮询间隔: \${POLL_INTERVAL}s"
  print "   日志: \${LOG_FILE}"
  print "   工作目录: \${SCRIPT_DIR}"
  echo ""

  # 单次模式
  if [ "\${1:-}" = "--once" ]; then
    check_and_handle
    echo ""
    exit $?
  fi

  # 持续轮询：状态栏始终在同一行更新
  while true; do
    check_and_handle || true
    # 等待期间显示倒计时状态
    for ((i=POLL_INTERVAL; i>0; i--)); do
      status_line "⏳ [$(date '+%H:%M:%S')] \${i}s 后下次检查 | 检查:\${TOTAL_CHECKS} 已处理:\${TOTAL_HANDLED}"
      sleep 1
    done
  done
}

main "$@"
`
}

export async function runLink(cwd: string): Promise<void> {
  const soulPath = join(cwd, 'SOUL.md')
  let content: string
  try {
    content = await readFile(soulPath, 'utf8')
  } catch {
    console.error(`未找到 ${soulPath}`)
    console.error('请确保当前目录存在 SOUL.md，且包含 agent 地址、agent ID 和 API key。')
    process.exit(2)
  }

  let cfg: SoulMailConfig
  try {
    cfg = parseSoulMailConfig(content)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(2)
  }

  const outPath = join(cwd, 'mail-poller.sh')
  const script = generateMailPollerScript(cfg)
  await writeFile(outPath, script, 'utf8')
  await chmod(outPath, 0o755)

  console.log(`✓ 已生成 ${outPath}`)
  console.log(`  Agent 地址: ${cfg.agentAddress}`)
  console.log(`  Agent ID:   ${cfg.agentId}`)
  console.log(`  API Key:    ${cfg.apiKey.slice(0, 8)}...`)
  console.log('')
  console.log('运行方式:')
  console.log('  ./mail-poller.sh              # 前台运行（Ctrl-C 停止）')
  console.log('  nohup ./mail-poller.sh &      # 后台运行')
  console.log('  ./mail-poller.sh --once       # 仅检查一次后退出')
}
