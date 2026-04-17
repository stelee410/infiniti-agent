import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  configExistsSync,
  ensureLocalAgentDir,
  getInfinitiConfigPath,
  loadConfig,
  saveProjectConfig,
} from '../config/io.js'
import type { InfinitiConfig } from '../config/types.js'

/** 合并进现有配置：LiveUI 使用指定 agent 的精灵表情目录（与 generate_avatar 默认输出一致）。 */
export function applySetLiveAgentToConfig(cfg: InfinitiConfig, agent: string): InfinitiConfig {
  const code = agent.trim().toLowerCase()
  const dir = `./live2d-models/${code}/expression`
  return {
    ...cfg,
    liveUi: {
      ...(cfg.liveUi ?? {}),
      spriteExpressions: {
        dir,
      },
    },
  }
}

export async function runSetLiveAgent(cwd: string, agent: string): Promise<void> {
  const code = agent.trim().toLowerCase()
  if (!code) {
    console.error('请提供 agent 代号，例如: infiniti-agent set_live_agent jess')
    process.exitCode = 2
    return
  }
  if (!configExistsSync(cwd)) {
    console.error('尚未配置。请先运行: infiniti-agent init 或 infiniti-agent migrate')
    process.exitCode = 2
    return
  }

  let cfg: InfinitiConfig
  try {
    cfg = await loadConfig(cwd)
  } catch (e) {
    console.error((e as Error).message)
    process.exitCode = 2
    return
  }

  const next = applySetLiveAgentToConfig(cfg, code)
  await ensureLocalAgentDir(cwd)
  await saveProjectConfig(cwd, next)

  const spriteRel = `./live2d-models/${code}/expression`
  const absExpr = join(cwd, 'live2d-models', code, 'expression')
  console.error(`[set_live_agent] 配置: ${getInfinitiConfigPath(cwd)}`)
  console.error(`[set_live_agent] 已设置 liveUi.spriteExpressions.dir = ${spriteRel}`)
  if (!existsSync(absExpr)) {
    console.error(
      `[set_live_agent] 警告: 目录尚不存在: ${absExpr}\n` +
        '  可先 sync + infiniti-agent generate_avatar --agent ' +
        code +
        ' ，或自行创建该目录并放入 exp_*.png / expressions.json。',
    )
  } else {
    console.error('[set_live_agent] 已检测到表情目录，可运行 infiniti-agent live 预览。')
  }
}
