#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { Command } from 'commander'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { configExistsSync, loadConfig, ensureLocalAgentDir } from './config/io.js'
import { InitWizard } from './ui/InitWizard.js'
import { ChatWithSplash } from './ui/ChatWithSplash.js'
import { McpManager } from './mcp/manager.js'
import { installSkillFromGit, installSkillFromPath } from './skills/install.js'
import { loadSkillsForCwd } from './skills/loader.js'
import {
  expandUserPath,
  localAgentDir,
  localSkillsDir,
  GLOBAL_AGENT_DIR,
} from './paths.js'
import { runCliPrompt } from './runCliPrompt.js'
import { readPackageVersion } from './packageRoot.js'
import { runLink } from './link.js'
import { LiveUiSession } from './liveui/wsSession.js'
import { createMinimaxTts } from './tts/minimaxTts.js'
import { createMossTtsNano } from './tts/mossTtsNano.js'
import { checkVoxcpmTtsHealth, createVoxcpmTts } from './tts/voxcpmTts.js'
import { createWhisperTts } from './tts/whisperTts.js'
import { createMimoTts } from './tts/mimoTts.js'
import { createWhisperAsr } from './asr/whisperAsr.js'
import { createSherpaOnnxAsr } from './asr/sherpaOnnxAsr.js'
import { spawnLiveElectron } from './liveui/spawnRenderer.js'
import { buildLiveUiVoiceMicEnvJson, VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD } from './liveui/voiceMicEnv.js'
import { runTestAsr, parseTestAsrRms, parseTestAsrInt } from './cli/testAsr.js'
import { runTestCamera, parseTestCameraInt } from './cli/testCamera.js'
import { resolveAvatarFallbackForUi, resolveLive2dModelForUi, resolveSpriteExpressionDirForUi } from './liveui/resolveModelPath.js'
import { runAddLlm, runSelectLlm } from './cli/llmCli.js'
import { runLinkyunShutdownPush, runLinkyunStartupSync, runLinkyunSync } from './cli/linkyunSync.js'
import { runGenerateAvatar } from './cli/generateAvatar.js'
import { runSetLiveAgent } from './cli/setLiveAgent.js'
import { parseWorkerCommand, runWorkerCommand } from './cli/workerCommands.js'
import { defaultLegacyCliDeps, parseLegacyCliCommand, runLegacyCliCommand } from './cli/legacyCliCommand.js'
import { parseGlobalFlags } from './cli/globalFlags.js'
import { runMigrateCommand } from './cli/migrateCommand.js'
import { runUpgradeCommand } from './cli/upgradeCommand.js'
import { exportAgentArchive, importAgentArchive } from './cli/agentArchive.js'
import { LiveCommandError, resolveLiveCommandPlan } from './cli/liveCommand.js'
import { disableUiLogFile, enableUiLogFile, withUiLogFile } from './utils/uiLogFile.js'

const cwd = process.cwd()
let startupSyncDone = false
let shutdownPushDone = false

function parseAddLlmProviderFlag(s?: string): 'openai' | 'anthropic' | 'gemini' | 'openrouter' | undefined {
  if (!s) return undefined
  const x = s.trim().toLowerCase()
  if (x === 'openai' || x === 'anthropic' || x === 'gemini' || x === 'openrouter') return x
  return undefined
}

function applyThinkingOverride(cfg: Awaited<ReturnType<typeof loadConfig>>, disable: boolean): Awaited<ReturnType<typeof loadConfig>> {
  if (!disable) return cfg
  return { ...cfg, thinking: { ...cfg.thinking, mode: 'disabled' as const } }
}

async function maybeRunStartupSync(): Promise<void> {
  if (startupSyncDone) return
  startupSyncDone = true
  if (process.env.INFINITI_AGENT_SKIP_STARTUP_SYNC === '1') return
  try {
    await runLinkyunStartupSync(cwd)
  } catch (e) {
    console.error(`[sync] 启动同步失败，继续启动: ${(e as Error).message}`)
  }
}

async function maybeRunShutdownPush(): Promise<void> {
  if (shutdownPushDone) return
  shutdownPushDone = true
  if (process.env.INFINITI_AGENT_SKIP_STARTUP_SYNC === '1') return
  try {
    await runLinkyunShutdownPush(cwd)
  } catch (e) {
    console.error(`[sync] 结束同步失败: ${(e as Error).message}`)
  }
}

function isUiModeInvocation(argv: string[]): boolean {
  if (argv.includes('--cli')) return false
  const globalFlags = new Set(['--debug', '--dangerously-skip-permissions', '--disable-thinking'])
  const rest = argv.filter((a) => !globalFlags.has(a))
  const command = rest[0]
  return !command || command === 'chat' || command === 'live'
}

async function configureLiveUiEngines(
  liveUi: LiveUiSession,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  liveUi.resetAudio()
  liveUi.setTtsEnabled(cfg.liveUi?.ttsAutoEnabled !== false)
  if (cfg.tts?.provider === 'minimax') {
    try {
      liveUi.setTtsEngine(createMinimaxTts(cfg.tts))
      console.error(
        `[liveui] MiniMax TTS 已启用 (model: ${cfg.tts.model ?? 'speech-02-turbo'}, voice: ${cfg.tts.voiceId ?? 'female-shaonv'})`,
      )
    } catch (e) {
      console.warn(`[liveui] TTS 未启用（配置或初始化失败）: ${(e as Error).message}`)
      liveUi.setTtsEngine(null)
    }
  } else if (cfg.tts?.provider === 'moss_tts_nano') {
    try {
      liveUi.setTtsEngine(createMossTtsNano(cfg.tts, cwd))
      console.error(`[liveui] MOSS-TTS-Nano 已启用 (baseUrl: ${cfg.tts.baseUrl})`)
    } catch (e) {
      console.warn(`[liveui] TTS 未启用（MOSS-TTS-Nano 初始化失败）: ${(e as Error).message}`)
      liveUi.setTtsEngine(null)
    }
  } else if (cfg.tts?.provider === 'voxcpm') {
    try {
      const health = await checkVoxcpmTtsHealth(cfg.tts)
      console.error(`[liveui] VoxCPM TTS 服务健康检查通过: ${health.slice(0, 160)}`)
      liveUi.setTtsEngine(createVoxcpmTts(cfg.tts, cwd))
      console.error(`[liveui] VoxCPM TTS 已启用 (baseUrl: ${cfg.tts.baseUrl})`)
    } catch (e) {
      console.warn(
        `[liveui] TTS 未启用（VoxCPM 服务不可用）: ${(e as Error).message}\n` +
          '  请先启动: cd ../infiniti-tts-service && ./scripts/start-voxcpm-tts-serve-mac.sh --port 8810',
      )
      liveUi.setTtsEngine(null)
    }
  } else if (cfg.tts?.provider === 'whisper') {
    try {
      liveUi.setTtsEngine(createWhisperTts(cfg.tts))
      console.error(
        `[liveui] Whisper TTS 已启用 (model: ${cfg.tts.model ?? 'gpt-4o-mini-tts'}, voice: ${cfg.tts.voiceId ?? 'alloy'})`,
      )
    } catch (e) {
      console.warn(`[liveui] TTS 未启用（Whisper 初始化失败）: ${(e as Error).message}`)
      liveUi.setTtsEngine(null)
    }
  } else if (cfg.tts?.provider === 'mimo') {
    try {
      liveUi.setTtsEngine(createMimoTts(cfg.tts, cwd))
      console.error(`[liveui] MiMo TTS 已启用 (model: ${cfg.tts.model})`)
    } catch (e) {
      console.warn(`[liveui] TTS 未启用（MiMo 初始化失败）: ${(e as Error).message}`)
      liveUi.setTtsEngine(null)
    }
  } else {
    liveUi.setTtsEngine(null)
  }

  if (cfg.asr?.provider === 'whisper') {
    try {
      liveUi.setAsrEngine(createWhisperAsr(cfg.asr))
      console.error(
        `[liveui] Whisper ASR 已启用 (model: ${cfg.asr.model ?? 'whisper-large-v3-turbo'}, baseUrl: ${cfg.asr.baseUrl})`,
      )
    } catch (e) {
      console.warn(`[liveui] ASR 未启用（Whisper 初始化失败）: ${(e as Error).message}`)
      liveUi.setAsrEngine(null)
    }
  } else if (cfg.asr?.provider === 'sherpa_onnx') {
    try {
      liveUi.setAsrEngine(await createSherpaOnnxAsr(cfg.asr, cwd))
      console.error(`[liveui] sherpa-onnx ASR 已启用 (model: ${cfg.asr.model})`)
    } catch (e) {
      console.warn(`[liveui] ASR 未启用（sherpa-onnx 加载失败）: ${(e as Error).message}`)
      liveUi.setAsrEngine(null)
    }
  } else {
    liveUi.setAsrEngine(null)
  }
}

function restartLiveUiElectron(
  liveUi: LiveUiSession,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  opts: { auto?: boolean; figureZoom?: number } = {},
): void {
  const spriteResolved = resolveSpriteExpressionDirForUi(cwd, cfg.liveUi)
  for (const w of spriteResolved?.warnings ?? []) {
    console.error(`[liveui] ${w}`)
  }

  const resolved = resolveLive2dModelForUi(cwd, cfg.liveUi)
  for (const w of resolved?.warnings ?? []) {
    console.error(`[liveui] ${w}`)
  }

  const useSprite = Boolean(spriteResolved?.dirFileUrl)
  const avatarFallback = useSprite ? null : resolveAvatarFallbackForUi(cwd)
  const renderer = cfg.liveUi?.renderer ?? (useSprite ? 'sprite' : 'live2d')
  const useReal2d = renderer === 'real2d' && useSprite
  const useSpriteOnly = renderer === 'sprite' && useSprite
  if (renderer === 'real2d' && !useSprite) {
    console.error('[liveui] renderer=real2d 需要 liveUi.spriteExpressions.dir，当前将回退 Live2D/占位')
  } else if (useReal2d) {
    console.error(`[liveui] 已启用 real2d（基于 spriteExpressions PNG），不使用 Live2D 模型 URL`)
  } else if (useSpriteOnly) {
    console.error(`[liveui] 已启用 spriteExpressions（PNG），不使用 Live2D 模型 URL`)
  }

  const child = spawnLiveElectron(liveUi.port, {
    renderer: useReal2d ? 'real2d' : useSpriteOnly ? 'sprite' : 'live2d',
    model3FileUrl: useReal2d || useSpriteOnly ? undefined : resolved?.model3FileUrl,
    spriteExpressionDirFileUrl: useReal2d || useSpriteOnly ? spriteResolved?.dirFileUrl : undefined,
    avatarFallbackFileUrl: avatarFallback?.avatarFileUrl,
    voiceMicJson: buildLiveUiVoiceMicEnvJson(cfg.liveUi, { auto: opts.auto === true }),
    figureZoom: resolveLiveUiFigureZoom(cfg, opts.figureZoom),
  })
  liveUi.setElectronChild(child)
  if (!child) {
    console.error('[liveui] Electron 未启动：已启动 WebSocket，可稍后自行对接渲染端。')
  } else {
    console.error(`[liveui] WebSocket ws://127.0.0.1:${liveUi.port} · Electron 已启动`)
  }
}

function resolveLiveUiFigureZoom(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  override?: number,
): number | undefined {
  const z = typeof override === 'number' ? override : cfg.liveUi?.figureZoom
  if (typeof z !== 'number' || !Number.isFinite(z)) return undefined
  return Math.max(0.4, Math.min(1.5, z))
}

async function runChatTui(
  opts: {
    skipPermissions?: boolean
    disableThinking?: boolean
    liveUi?: LiveUiSession | null
    liveUiRenderer?: 'live2d' | 'sprite' | 'real2d'
    liveUiModel3FileUrl?: string
    /** `live` 且配置了 `spriteExpressions.dir` 时注入 Electron（`INFINITI_LIVEUI_SPRITE_EXPRESSION_DIR`） */
    liveUiSpriteExpressionDirFileUrl?: string
    /** `spriteExpressions.dir` 不可用时注入圆形头像兜底 */
    liveUiAvatarFallbackFileUrl?: string
    /** `live` 时注入麦克 VAD（JSON → Electron `INFINITI_LIVEUI_VOICE_MIC`） */
    liveUiVoiceMicJson?: string
    /** `live --zoom` 注入：人物显示缩放（0.4 ~ 1.5），不影响控制条/输入框 */
    liveUiFigureZoom?: number
    /** 仅启动 WebSocket/live agent 处理链路，不打开 Electron LiveUI 窗口。 */
    liveUiHeadless?: boolean
    onConfigReload?: (config: Awaited<ReturnType<typeof loadConfig>>) => Promise<void>
  } = {},
): Promise<void> {
  if (!configExistsSync(cwd)) {
    const { waitUntilExit } = render(<InitWizard />)
    await waitUntilExit()
    return
  }
  let cfg
  try {
    cfg = applyThinkingOverride(await loadConfig(cwd), opts.disableThinking ?? false)
  } catch (e) {
    console.error((e as Error).message)
    const { waitUntilExit } = render(<InitWizard />)
    await waitUntilExit()
    return
  }
  const mcp = new McpManager()
  const liveUi = opts.liveUi ?? null
  try {
    if (liveUi) {
      if (process.env.INFINITI_AGENT_DEBUG === '1') {
        process.env.INFINITI_LIVEUI_DEVTOOLS = '1'
      }
      await liveUi.start()
      liveUi.startMouthPump()
      await configureLiveUiEngines(liveUi, cfg)
      if (opts.liveUiHeadless) {
        console.error(`[liveui] WebSocket ws://127.0.0.1:${liveUi.port} · 无头模式，未启动 Electron`)
      } else {
        const child = spawnLiveElectron(liveUi.port, {
          renderer: opts.liveUiRenderer,
          model3FileUrl: opts.liveUiModel3FileUrl,
          spriteExpressionDirFileUrl: opts.liveUiSpriteExpressionDirFileUrl,
          avatarFallbackFileUrl: opts.liveUiAvatarFallbackFileUrl,
          voiceMicJson: opts.liveUiVoiceMicJson,
          figureZoom: resolveLiveUiFigureZoom(cfg, opts.liveUiFigureZoom),
        })
        liveUi.setElectronChild(child)
        if (!child) {
          console.error('[liveui] Electron 未启动：已启动 WebSocket，可稍后自行对接渲染端。')
        } else {
          console.error(`[liveui] WebSocket ws://127.0.0.1:${liveUi.port} · Electron 已启动`)
        }
      }
    }
    await mcp.start(cfg)
    const skipPerm = opts.skipPermissions ?? false
    const { waitUntilExit } = render(
      <ChatWithSplash
        config={cfg}
        mcp={mcp}
        dangerouslySkipPermissions={skipPerm}
        liveUi={liveUi}
        onConfigReload={opts.onConfigReload}
      />,
      { maxFps: 30, incrementalRendering: false },
    )
    await waitUntilExit()
  } finally {
    if (liveUi) await liveUi.dispose()
    await mcp.stop()
  }
}

async function main(): Promise<void> {
  const uiLogEnabledAtStartup = isUiModeInvocation(process.argv.slice(2))
  if (uiLogEnabledAtStartup) enableUiLogFile(cwd)
  try {
  const parsedGlobalFlags = parseGlobalFlags(process.argv.slice(2))
  if (parsedGlobalFlags.debug) {
    process.env.INFINITI_AGENT_DEBUG = '1'
    console.error('[debug] 调试模式已启用，meta-agent / 工具调度等详细日志将输出到 stderr')
  }

  const skipPermissions = parsedGlobalFlags.skipPermissions
  if (skipPermissions) {
    console.error('⚠ --dangerously-skip-permissions: 所有工具确认将被跳过')
  }

  const disableThinking = parsedGlobalFlags.disableThinking
  process.argv = [process.argv[0]!, process.argv[1]!, ...parsedGlobalFlags.argv]
  const argv = parsedGlobalFlags.argv

  const workerCommand = parseWorkerCommand(argv)
  if (workerCommand) {
    await runWorkerCommand(workerCommand)
    return
  }

  const legacyCliCommand = parseLegacyCliCommand(argv)
  if (legacyCliCommand) {
    await maybeRunStartupSync()
    await runLegacyCliCommand(
      legacyCliCommand,
      defaultLegacyCliDeps(cwd, disableThinking, applyThinkingOverride),
    )
    await maybeRunShutdownPush()
    return
  }

  if (argv.length === 0) {
    process.argv.push('chat')
  }

  const program = new Command()
  program
    .name('infiniti-agent')
    .description(
      'LinkYun Infiniti Agent — 项目级智能体框架。数据存储在当前目录 .infiniti-agent/ 下。首次使用请运行 infiniti-agent migrate 从全局配置初始化。',
    )
    .version(readPackageVersion())

  program
    .command('init')
    .description('配置 LLM（provider / base URL / model / api key），写入全局 ~/.infiniti-agent/config.json')
    .action(async () => {
      const { waitUntilExit } = render(<InitWizard />)
      await waitUntilExit()
    })

  program
    .command('migrate')
    .description('将全局 ~/.infiniti-agent/ 配置复制到当前目录 .infiniti-agent/，实现项目级独立')
    .action(async () => {
      await runMigrateCommand(cwd)
    })

  program
    .command('upgrade')
    .description('升级 config.json 到最新格式（旧平铺 llm → profiles，移除废弃字段）')
    .option('--global', '升级全局 ~/.infiniti-agent/config.json（默认升级当前目录的）')
    .action(async (cmdOpts: { global?: boolean }) => {
      await runUpgradeCommand(cwd, cmdOpts)
    })

  program
    .command('export')
    .description('导出当前目录的 agent layout（.infiniti-agent/、SOUL.md 等）为 zip 格式 .agent 文件')
    .argument('<file>', '输出文件，例如 jess.agent')
    .action(async (file: string) => {
      try {
        const result = await exportAgentArchive(cwd, file)
        console.log(`✓ 已导出 ${result.entries.length} 项到 ${result.archivePath}`)
      } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
      }
    })

  program
    .command('import')
    .description('从 .agent（zip）文件导入 agent layout 到当前目录；已有 layout 时会询问是否覆盖')
    .argument('<file>', '输入文件，例如 jess.agent')
    .option('-f, --force', '已有 agent layout 时直接覆盖，跳过确认')
    .action(async (file: string, cmdOpts: { force?: boolean }) => {
      try {
        const result = await importAgentArchive(cwd, file, { force: cmdOpts.force })
        const prefix = result.overwritten ? '✓ 已覆盖并导入' : '✓ 已导入'
        console.log(`${prefix} ${result.entries.length} 项到 ${cwd}`)
      } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
      }
    })

  program
    .command('add_llm')
    .description('交互式添加 LLM profile 到项目 .infiniti-agent/config.json（拉取模型列表、选模型）')
    .option('--profile <name>', 'Profile 名称（默认 main）')
    .option(
      '--provider <name>',
      '跳过厂商选择：openai | anthropic | gemini | openrouter',
    )
    .action(async (cmd: { profile?: string; provider?: string }) => {
      const p = parseAddLlmProviderFlag(cmd.provider)
      if (cmd.provider?.trim() && !p) {
        console.error('--provider 须为 openai | anthropic | gemini | openrouter')
        process.exit(2)
        return
      }
      await ensureLocalAgentDir(cwd)
      await runAddLlm(cwd, { profile: cmd.profile, provider: p })
    })

  program
    .command('select_llm')
    .description('切换项目默认 LLM（写入 .infiniti-agent/config.json 的 llm.default）')
    .option('--name <profile>', '直接指定 profile 名，跳过交互')
    .action(async (cmd: { name?: string }) => {
      await ensureLocalAgentDir(cwd)
      await runSelectLlm(cwd, { name: cmd.name })
    })

  program
    .command('chat')
    .description('进入对话界面（无参数时默认）')
    .action(async () => {
      await withUiLogFile(cwd, async () => {
        await maybeRunStartupSync()
        await runChatTui({ skipPermissions, disableThinking })
        await maybeRunShutdownPush()
      })
    })

  program
    .command('live')
    .description('LiveUI：本地 WebSocket + Electron 透明渲染 + TUI（需 npm run build 生成 liveui/dist）')
    .option('-p, --port <port>', 'WebSocket 端口（覆盖 config.json 中 liveUi.port）')
    .option('--auto', '语音输入使用自动 VAD 模式；默认需按住空格录音，松开发送识别')
    .option('--headless', '无头模式：仅启动 Live WebSocket，不打开 LiveUI 窗口')
    .option('--headness', '无头模式别名：等同于 --headless')
    .option(
      '--zoom <n>',
      '人物显示缩放（0.4 ~ 1.5；0.9 = 90%、0.8 = 80%；不影响控制条/输入框）',
    )
    .action(async (cmdOpts: { port?: string; zoom?: string; auto?: boolean; headless?: boolean; headness?: boolean }) => {
      await withUiLogFile(cwd, async () => {
        await maybeRunStartupSync()
        if (!configExistsSync(cwd)) {
          console.error('尚未配置。请先运行: infiniti-agent init 或 infiniti-agent migrate')
          process.exit(2)
        }
        let cfg: Awaited<ReturnType<typeof loadConfig>>
        try {
          cfg = applyThinkingOverride(await loadConfig(cwd), disableThinking)
        } catch (e) {
          console.error((e as Error).message)
          process.exit(2)
        }

        let livePlan: ReturnType<typeof resolveLiveCommandPlan>
        try {
          livePlan = resolveLiveCommandPlan(cwd, cfg, cmdOpts)
        } catch (e) {
          if (e instanceof LiveCommandError) {
            console.error(e.message)
            process.exit(2)
          }
          throw e
        }
        for (const w of livePlan.warnings) {
          console.error(`[liveui] ${w}`)
        }
        for (const msg of livePlan.info) {
          console.error(`[liveui] ${msg}`)
        }

        const liveUi = new LiveUiSession(livePlan.port, { mediaRoots: [localAgentDir(cwd)] })
        await runChatTui({
          skipPermissions,
          disableThinking,
          liveUi,
          liveUiRenderer: livePlan.renderer,
          liveUiModel3FileUrl: livePlan.model3FileUrl,
          liveUiSpriteExpressionDirFileUrl: livePlan.spriteExpressionDirFileUrl,
          liveUiAvatarFallbackFileUrl: livePlan.avatarFallbackFileUrl,
          liveUiVoiceMicJson: livePlan.voiceMicJson,
          liveUiFigureZoom: livePlan.figureZoomOverride,
          liveUiHeadless: livePlan.headless,
          onConfigReload: async (nextCfg) => {
            if (nextCfg.liveUi?.port && nextCfg.liveUi.port !== liveUi.port) {
              console.warn(
                `[liveui] liveUi.port 已保存为 ${nextCfg.liveUi.port}，当前会话仍使用 ws://127.0.0.1:${liveUi.port}；端口变更需下次启动生效。`,
              )
            }
            await configureLiveUiEngines(liveUi, nextCfg)
            if (!livePlan.headless) {
              restartLiveUiElectron(liveUi, nextCfg, {
                auto: cmdOpts.auto === true,
                figureZoom: livePlan.figureZoomOverride,
              })
            }
          },
        })
        await maybeRunShutdownPush()
      })
    })

  program
    .command('test_camera')
    .alias('test-camera')
    .description('摄像头拍照测试：通过 CLI 后端直接拍一张 JPEG 到 /tmp，并输出完整日志路径。')
    .option('--output <path>', '图片输出路径（默认 /tmp/infiniti-agent-camera-<time>.jpg）')
    .option('--log <path>', '日志输出路径（默认 /tmp/infiniti-agent-camera-<time>.log）')
    .option('--timeout-ms <n>', '测试总超时（毫秒）', '20000')
    .action(async (cmdOpts: { output?: string; log?: string; timeoutMs?: string }) => {
      const timeoutMs = parseTestCameraInt(cmdOpts.timeoutMs, 20000, '--timeout-ms')
      const code = await runTestCamera({
        output: cmdOpts.output,
        log: cmdOpts.log,
        timeoutMs,
      })
      process.exit(code)
    })

  program
    .command('test_asr')
    .description(
      '麦克风 RMS 分段测试：用 ffmpeg 采集音频，按 --rms 与静音切段调用 config 中的 ASR；stdout 输出识别文本并以 <停顿> 连接（Ctrl+C 结束）。需已安装 ffmpeg。',
    )
    .option('--rms <n>', 'RMS 阈值（与 liveUi.voiceMicSpeechRmsThreshold 一致）')
    .option('--silence-ms <n>', '静音判停时长（毫秒）', '1500')
    .option('--min-chunk-ms <n>', '最短送识别片段（毫秒）', '250')
    .action(async (cmdOpts: { rms?: string; silenceMs?: string; minChunkMs?: string }) => {
      if (!configExistsSync(cwd)) {
        console.error('尚未配置。请先运行: infiniti-agent init 或 infiniti-agent migrate')
        process.exit(2)
      }
      const rms = parseTestAsrRms(cmdOpts.rms, VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD)
      const silenceMs = parseTestAsrInt(cmdOpts.silenceMs, 1500, '--silence-ms', 200, 12000)
      const minChunkMs = parseTestAsrInt(cmdOpts.minChunkMs, 250, '--min-chunk-ms', 80, 5000)
      try {
        const code = await runTestAsr(cwd, { rms, silenceMs, minChunkMs })
        process.exit(code)
      } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
      }
    })

  program
    .command('cli')
    .description('非交互执行一轮（多词无需引号）')
    .argument('<prompt...>', 'prompt 内容')
    .action(async (promptParts: string[]) => {
      const prompt = promptParts.join(' ').trim()
      if (!prompt) {
        console.error('用法: infiniti-agent cli <prompt>')
        process.exit(2)
      }
      await maybeRunStartupSync()
      if (!configExistsSync(cwd)) {
        console.error('尚未配置。请先运行: infiniti-agent init 或 infiniti-agent migrate')
        process.exit(2)
      }
      try {
        const cfg = applyThinkingOverride(await loadConfig(cwd), disableThinking)
        await runCliPrompt(cfg, prompt)
        await maybeRunShutdownPush()
      } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
      }
    })

  program
    .command('link')
    .description('从 SOUL.md 提取邮件配置，生成 mail-poller.sh 邮件轮询守护脚本')
    .action(async () => {
      await runLink(cwd)
    })

  program
    .command('generate_avatar')
    .description(
      '根据 .infiniti-agent/ref/<agent>/ 的头像与设定稿，经 OpenRouter 图像 API 生成半身像与各表情 PNG；最后将 half_body 与各 exp 做边缘连通背景透明（默认 Nano Banana Pro：google/gemini-3-pro-image-preview；可用 avatarGen.model 或 INFINITI_AVATAR_GEN_MODEL 覆盖）',
    )
    .requiredOption('--agent <code>', 'LinkYun Agent code（与 sync 后 ref 目录名一致，如 jess）')
    .option('--out <dir>', '表情输出目录（默认 live2d-models/<agent>/expression）')
    .option('--skip-half-body', '跳过新半身像，复用输出目录已有 half_body.png')
    .option('--no-transparentize', '跳过最后一步：将 half_body / 各 exp PNG 的背景改为透明')
    .action(async (cmd: { agent: string; out?: string; skipHalfBody?: boolean; noTransparentize?: boolean }) => {
      try {
        await runGenerateAvatar(cwd, {
          agent: cmd.agent,
          outDir: cmd.out,
          skipHalfBody: cmd.skipHalfBody,
          noTransparentize: cmd.noTransparentize,
        })
      } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
      }
    })

  program
    .command('set_live_agent')
    .description(
      '将 LiveUI 形象设为指定 agent：写入 liveUi.spriteExpressions.dir = ./live2d-models/<code>/expression（与 generate_avatar 输出一致）',
    )
    .argument('<code>', 'Agent 代号，如 jess')
    .action(async (code: string) => {
      await runSetLiveAgent(cwd, code)
      if (process.exitCode === 2) process.exit(2)
    })

  program
    .command('sync')
    .description(
      '登录 LinkYun，选择 AI Agent，同步 SOUL/素材，并按 session.json 时间戳双向同步 .agent 归档',
    )
    .option(
      '--api-base <url>',
      'API 根地址（不含 /api/v1；省略时在终端询问，直接 Enter 为 https://api.linkyun.co）',
    )
    .option('--workspace <code>', '指定 X-Workspace-Code（默认使用登录接口返回的工作空间）')
    .option('--agent <code>', '指定 LinkYun Agent code，并写入 .env.local')
    .option('--login', '强制重新登录并刷新 .env.local')
    .option('--pull', '强制以服务器最新 .agent 为准，下载并覆盖当前 layout')
    .option('--push', '强制以本地 layout 为准，导出并上传 .agent')
    .option('--with-version', '列出服务器 .agent 版本，选择指定版本下载并覆盖当前 layout')
    .action(async (cmd: {
      apiBase?: string
      workspace?: string
      agent?: string
      login?: boolean
      pull?: boolean
      push?: boolean
      withVersion?: boolean
    }) => {
      try {
        await runLinkyunSync(cwd, {
          apiBase: cmd.apiBase,
          workspaceCode: cmd.workspace,
          agentCode: cmd.agent,
          forceLogin: cmd.login,
          pull: cmd.pull,
          push: cmd.push,
          withVersion: cmd.withVersion,
        })
      } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
      }
    })

  const skill = program.command('skill').description('当前项目的 Skills（存储在 .infiniti-agent/skills/）')

  const installSkillAction = async (source: string) => {
    await ensureLocalAgentDir(cwd)
    const s = source.trim()
    let dest: string
    if (/^https?:\/\//i.test(s) || s.startsWith('git@')) {
      dest = await installSkillFromGit(cwd, s)
    } else if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(s)) {
      dest = await installSkillFromGit(cwd, `https://github.com/${s}.git`)
    } else {
      const p = expandUserPath(s)
      if (!existsSync(p)) {
        console.error('路径不存在。请提供 owner/repo、git URL 或本地路径。')
        process.exitCode = 1
        return
      }
      dest = await installSkillFromPath(cwd, p)
    }
    console.log(dest)
  }

  skill
    .command('install <source>')
    .description('安装 Skill（支持 owner/repo、git URL、本地路径）')
    .action(installSkillAction)

  skill
    .command('add <source>')
    .description('install 的别名')
    .action(installSkillAction)

  skill
    .command('list')
    .description('列出当前项目已安装的 Skills')
    .action(async () => {
      const skills = await loadSkillsForCwd(cwd)
      if (!skills.length) {
        console.log('(暂无)')
        return
      }
      for (const x of skills) {
        console.log(`${x.id}\t${x.title}`)
      }
    })

  await program.parseAsync(process.argv)
  } finally {
    if (uiLogEnabledAtStartup) disableUiLogFile()
  }
}

main().catch((e) => {
  const uiMode = isUiModeInvocation(process.argv.slice(2))
  if (uiMode) enableUiLogFile(cwd)
  console.error(e)
  if (uiMode) disableUiLogFile()
  process.exit(1)
})
