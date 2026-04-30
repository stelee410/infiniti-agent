import type { InfinitiConfig } from '../config/types.js'
import { configExistsSync, loadConfig } from '../config/io.js'
import { runCliPrompt } from '../runCliPrompt.js'

export type LegacyCliCommand = {
  prompt: string
}

export type LegacyCliDeps = {
  cwd: string
  disableThinking: boolean
  configExistsSync: (cwd?: string) => boolean
  loadConfig: (cwd?: string) => Promise<InfinitiConfig>
  applyThinkingOverride: (cfg: InfinitiConfig, disable: boolean) => InfinitiConfig
  runCliPrompt: (cfg: InfinitiConfig, prompt: string) => Promise<void>
}

export type LegacyCliIo = {
  error(message: string): void
  exit(code: number): never
}

export function parseLegacyCliCommand(argv: string[]): LegacyCliCommand | null {
  const cliIdx = argv.indexOf('--cli')
  if (cliIdx === -1) return null
  return {
    prompt: argv.slice(cliIdx + 1).join(' ').trim(),
  }
}

export async function runLegacyCliCommand(
  command: LegacyCliCommand,
  deps: LegacyCliDeps,
  io: LegacyCliIo = {
    error: (message) => console.error(message),
    exit: (code) => process.exit(code),
  },
): Promise<true> {
  if (!command.prompt) {
    io.error('用法: infiniti-agent cli <prompt>（多词无需引号）')
    io.exit(2)
  }
  if (!deps.configExistsSync(deps.cwd)) {
    io.error('尚未配置。请先运行: infiniti-agent init 或 infiniti-agent migrate')
    io.exit(2)
  }
  try {
    const cfg = deps.applyThinkingOverride(await deps.loadConfig(deps.cwd), deps.disableThinking)
    await deps.runCliPrompt(cfg, command.prompt)
  } catch (e) {
    io.error((e as Error).message)
    io.exit(2)
  }
  return true
}

export function defaultLegacyCliDeps(
  cwd: string,
  disableThinking: boolean,
  applyThinkingOverride: LegacyCliDeps['applyThinkingOverride'],
): LegacyCliDeps {
  return {
    cwd,
    disableThinking,
    configExistsSync,
    loadConfig,
    applyThinkingOverride,
    runCliPrompt,
  }
}
