#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { Command } from 'commander'
import { existsSync } from 'fs'
import { cp, mkdir } from 'fs/promises'
import { resolve } from 'path'
import { configExistsSync, loadConfig, ensureLocalAgentDir, upgradeConfig } from './config/io.js'
import { InitWizard } from './ui/InitWizard.js'
import { ChatWithSplash } from './ui/ChatWithSplash.js'
import { McpManager } from './mcp/manager.js'
import { enableSyncOutput, disableSyncOutput } from './ui/terminalSync.js'
import { installSkillFromGit, installSkillFromPath } from './skills/install.js'
import { loadSkillsForCwd } from './skills/loader.js'
import {
  expandUserPath,
  localAgentDir,
  localSkillsDir,
  GLOBAL_AGENT_DIR,
  GLOBAL_CONFIG_PATH,
  GLOBAL_SKILLS_DIR,
  GLOBAL_MEMORY_PATH,
  localConfigPath,
  localMemoryPath,
} from './paths.js'
import { runCliPrompt } from './runCliPrompt.js'
import { readPackageVersion } from './packageRoot.js'
import { runLink } from './link.js'
import { LiveUiSession } from './liveui/wsSession.js'
import { createMinimaxTts } from './tts/minimaxTts.js'
import { createMossTtsNano } from './tts/mossTtsNano.js'
import { checkVoxcpmTtsHealth, createVoxcpmTts } from './tts/voxcpmTts.js'
import { createWhisperTts } from './tts/whisperTts.js'
import { createWhisperAsr } from './asr/whisperAsr.js'
import { createSherpaOnnxAsr } from './asr/sherpaOnnxAsr.js'
import { spawnLiveElectron } from './liveui/spawnRenderer.js'
import { buildLiveUiVoiceMicEnvJson, VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD } from './liveui/voiceMicEnv.js'
import { runTestAsr, parseTestAsrRms, parseTestAsrInt } from './cli/testAsr.js'
import { runTestCamera, parseTestCameraInt } from './cli/testCamera.js'
import { resolveLive2dModelForUi, resolveSpriteExpressionDirForUi } from './liveui/resolveModelPath.js'
import { runAddLlm, runSelectLlm } from './cli/llmCli.js'
import { runLinkyunSync } from './cli/linkyunSync.js'
import { runGenerateAvatar } from './cli/generateAvatar.js'
import { runSetLiveAgent } from './cli/setLiveAgent.js'
import { runSnapPhotoJob } from './snap/asyncSnap.js'
import { disableUiLogFile, enableUiLogFile, withUiLogFile } from './utils/uiLogFile.js'
import { Real2dClient } from './real2d/client.js'
import type { LiveUiReal2dFalConfig } from './config/types.js'
import type { Real2dFalConfig } from './real2d/protocol.js'

const cwd = process.cwd()

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

function resolveLiveUiRenderer(cfg: Awaited<ReturnType<typeof loadConfig>>, useSprite: boolean): 'live2d' | 'sprite' | 'real2d' {
  return cfg.liveUi?.renderer ?? (useSprite ? 'sprite' : 'live2d')
}

function buildLiveUiReal2dEnvJson(cfg: Awaited<ReturnType<typeof loadConfig>>): string | undefined {
  const r = cfg.liveUi?.real2d
  if (!r) return undefined
  return JSON.stringify({
    enabled: r.enabled !== false,
    backend: r.backend ?? 'local',
    baseUrl: r.baseUrl ?? 'http://127.0.0.1:8921',
    fps: r.fps ?? 25,
    frameFormat: r.frameFormat ?? 'jpeg',
    fallbackRenderer: r.fallbackRenderer ?? 'sprite',
    mouthDriver: r.mouthDriver ?? 'rms',
    fal: r.fal
      ? {
          keyEnv: r.fal.keyEnv ?? 'FAL_KEY',
          mode: r.fal.mode ?? 'ai-avatar',
          model: r.fal.model ?? 'fal-ai/ai-avatar',
          imageModel: r.fal.imageModel ?? 'fal-ai/live-portrait/image',
          lipsyncModel: r.fal.lipsyncModel ?? 'creatify/lipsync',
          drivingVideoUrl: r.fal.drivingVideoUrl,
          imageUrl: r.fal.imageUrl,
          audioUrl: r.fal.audioUrl,
          pollIntervalMs: r.fal.pollIntervalMs ?? 1000,
          requestTimeoutMs: r.fal.requestTimeoutMs ?? 300000,
        }
      : undefined,
  })
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

  const real2d = cfg.liveUi?.real2d
  const wantsReal2d = cfg.liveUi?.renderer === 'real2d' || real2d?.enabled === true
  if (wantsReal2d && real2d?.enabled !== false) {
    if ((real2d?.backend ?? 'local') === 'fal') {
      liveUi.setReal2dFalRenderer({
        backend: 'fal',
        sourceImage: real2d?.sourceImage ? resolve(cwd, real2d.sourceImage) : undefined,
        fal: buildReal2dFalStartConfig(real2d?.fal),
      })
      console.error(`[liveui] real2d fal 已配置 (model: ${real2d?.fal?.model ?? 'fal-ai/ai-avatar'})`)
      return
    }
    const client = new Real2dClient({
      baseUrl: real2d?.baseUrl,
      timeoutMs: real2d?.timeoutMs,
    })
    liveUi.setReal2dClient(client, {
      backend: real2d?.backend ?? 'local',
      sourceImage: real2d?.sourceImage ? resolve(cwd, real2d.sourceImage) : undefined,
      fps: real2d?.fps,
      frameFormat: real2d?.frameFormat,
      fal: buildReal2dFalStartConfig(real2d?.fal),
    })
    console.error(`[liveui] real2d 已配置 (baseUrl: ${client.baseUrl})`)
  } else {
    liveUi.setReal2dClient(null)
  }
}

function buildReal2dFalStartConfig(fal?: LiveUiReal2dFalConfig): Real2dFalConfig | undefined {
  if (!fal) return undefined
  return {
    apiKey: fal.apiKey,
    keyEnv: fal.keyEnv ?? 'FAL_KEY',
    mode: fal.mode ?? 'ai-avatar',
    model: fal.model ?? 'fal-ai/ai-avatar',
    imageModel: fal.imageModel ?? 'fal-ai/live-portrait/image',
    lipsyncModel: fal.lipsyncModel ?? 'creatify/lipsync',
    drivingVideoUrl: fal.drivingVideoUrl,
    imageUrl: fal.imageUrl,
    audioUrl: fal.audioUrl,
    pollIntervalMs: fal.pollIntervalMs ?? 1000,
    requestTimeoutMs: fal.requestTimeoutMs ?? 300000,
    options: normalizeFalOptions(fal.options),
  }
}

function normalizeFalOptions(options?: LiveUiReal2dFalConfig['options']): Record<string, number | boolean | string> | undefined {
  if (!options) return undefined
  const out: Record<string, number | boolean | string> = {}
  const map: Record<string, string> = {
    pupilX: 'pupil_x',
    pupilY: 'pupil_y',
    rotatePitch: 'rotate_pitch',
    rotateYaw: 'rotate_yaw',
    rotateRoll: 'rotate_roll',
    flagLipZero: 'flag_lip_zero',
    flagEyeRetargeting: 'flag_eye_retargeting',
    flagLipRetargeting: 'flag_lip_retargeting',
    flagStitching: 'flag_stitching',
    flagRelative: 'flag_relative',
    flagPasteback: 'flag_pasteback',
    flagDoCrop: 'flag_do_crop',
    flagDoRot: 'flag_do_rot',
    vxRatio: 'vx_ratio',
    vyRatio: 'vy_ratio',
    batchSize: 'batch_size',
    enableSafetyChecker: 'enable_safety_checker',
  }
  for (const [k, v] of Object.entries(options)) {
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[map[k] ?? k] = v
  }
  return Object.keys(out).length ? out : undefined
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
  const renderer = resolveLiveUiRenderer(cfg, useSprite)
  if (useSprite) {
    console.error(`[liveui] 已启用 spriteExpressions（PNG），不使用 Live2D 模型 URL`)
  }

  const child = spawnLiveElectron(liveUi.port, {
    renderer,
    model3FileUrl: useSprite ? undefined : resolved?.model3FileUrl,
    spriteExpressionDirFileUrl: spriteResolved?.dirFileUrl,
    voiceMicJson: buildLiveUiVoiceMicEnvJson(cfg.liveUi, { auto: opts.auto === true }),
    figureZoom: opts.figureZoom,
    real2dJson: buildLiveUiReal2dEnvJson(cfg),
  })
  liveUi.setElectronChild(child)
  if (!child) {
    console.error('[liveui] Electron 未启动：已启动 WebSocket，可稍后自行对接渲染端。')
  } else {
    console.error(`[liveui] WebSocket ws://127.0.0.1:${liveUi.port} · Electron 已启动`)
  }
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
    /** `live` 时注入麦克 VAD（JSON → Electron `INFINITI_LIVEUI_VOICE_MIC`） */
    liveUiVoiceMicJson?: string
    liveUiReal2dJson?: string
    /** `live --zoom` 注入：人物显示缩放（0.4 ~ 1.5），不影响控制条/输入框 */
    liveUiFigureZoom?: number
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
  enableSyncOutput()
  try {
    if (liveUi) {
      if (process.env.INFINITI_AGENT_DEBUG === '1') {
        process.env.INFINITI_LIVEUI_DEVTOOLS = '1'
      }
      await liveUi.start()
      liveUi.startMouthPump()
      await configureLiveUiEngines(liveUi, cfg)
      const child = spawnLiveElectron(liveUi.port, {
        renderer: opts.liveUiRenderer,
        model3FileUrl: opts.liveUiModel3FileUrl,
        spriteExpressionDirFileUrl: opts.liveUiSpriteExpressionDirFileUrl,
        voiceMicJson: opts.liveUiVoiceMicJson,
        real2dJson: opts.liveUiReal2dJson,
        figureZoom: opts.liveUiFigureZoom,
      })
      liveUi.setElectronChild(child)
      if (!child) {
        console.error('[liveui] Electron 未启动：已启动 WebSocket，可稍后自行对接渲染端。')
      } else {
        console.error(`[liveui] WebSocket ws://127.0.0.1:${liveUi.port} · Electron 已启动`)
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
      { maxFps: 15, incrementalRendering: true },
    )
    await waitUntilExit()
  } finally {
    disableSyncOutput()
    if (liveUi) await liveUi.dispose()
    await mcp.stop()
  }
}

async function main(): Promise<void> {
  const uiLogEnabledAtStartup = isUiModeInvocation(process.argv.slice(2))
  if (uiLogEnabledAtStartup) enableUiLogFile(cwd)
  try {
  if (process.argv.includes('--debug')) {
    const idx = process.argv.indexOf('--debug')
    process.argv.splice(idx, 1)
    process.env.INFINITI_AGENT_DEBUG = '1'
    console.error('[debug] 调试模式已启用，meta-agent / 工具调度等详细日志将输出到 stderr')
  }

  const skipPermissions = process.argv.includes('--dangerously-skip-permissions')
  if (skipPermissions) {
    const idx = process.argv.indexOf('--dangerously-skip-permissions')
    process.argv.splice(idx, 1)
    console.error('⚠ --dangerously-skip-permissions: 所有工具确认将被跳过')
  }

  const disableThinking = process.argv.includes('--disable-thinking')
  if (disableThinking) {
    const idx = process.argv.indexOf('--disable-thinking')
    process.argv.splice(idx, 1)
  }
  const argv = process.argv.slice(2)

  if (argv[0] === 'snap-worker') {
    const jobPath = argv[1]
    if (!jobPath) {
      console.error('用法: infiniti-agent snap-worker <job.json>')
      process.exit(2)
    }
    try {
      await runSnapPhotoJob(jobPath)
    } catch (e) {
      console.error((e as Error).message)
      process.exit(2)
    }
    return
  }

  // 兼容旧写法 --cli
  const cliIdx = argv.indexOf('--cli')
  if (cliIdx !== -1) {
    const prompt = argv.slice(cliIdx + 1).join(' ').trim()
    if (!prompt) {
      console.error('用法: infiniti-agent cli <prompt>（多词无需引号）')
      process.exit(2)
    }
    if (!configExistsSync(cwd)) {
      console.error('尚未配置。请先运行: infiniti-agent init 或 infiniti-agent migrate')
      process.exit(2)
    }
    try {
      const cfg = applyThinkingOverride(await loadConfig(cwd), disableThinking)
      await runCliPrompt(cfg, prompt)
    } catch (e) {
      console.error((e as Error).message)
      process.exit(2)
    }
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
      const localDir = localAgentDir(cwd)
      await mkdir(localDir, { recursive: true })
      let copied = 0

      if (existsSync(GLOBAL_CONFIG_PATH) && !existsSync(localConfigPath(cwd))) {
        await cp(GLOBAL_CONFIG_PATH, localConfigPath(cwd))
        console.log(`✓ config.json → ${localConfigPath(cwd)}`)
        copied++
      }

      if (existsSync(GLOBAL_MEMORY_PATH) && !existsSync(localMemoryPath(cwd))) {
        await cp(GLOBAL_MEMORY_PATH, localMemoryPath(cwd))
        console.log(`✓ memory.md → ${localMemoryPath(cwd)}`)
        copied++
      }

      if (existsSync(GLOBAL_SKILLS_DIR)) {
        const localSkills = localSkillsDir(cwd)
        if (!existsSync(localSkills)) {
          await cp(GLOBAL_SKILLS_DIR, localSkills, { recursive: true })
          console.log(`✓ skills/ → ${localSkills}`)
          copied++
        }
      }

      if (copied === 0) {
        console.log('无需迁移（本地已存在或全局无配置）。如需首次配置请运行: infiniti-agent init')
      } else {
        console.log(`\n已迁移 ${copied} 项到 ${localDir}`)
        console.log('后续所有 session、memory、skills 均在此目录下独立运行。')
      }
    })

  program
    .command('upgrade')
    .description('升级 config.json 到最新格式（旧平铺 llm → profiles，移除废弃字段）')
    .option('--global', '升级全局 ~/.infiniti-agent/config.json（默认升级当前目录的）')
    .action(async (cmdOpts: { global?: boolean }) => {
      const targets: string[] = []
      const localCfg = localConfigPath(cwd)
      const globalCfg = GLOBAL_CONFIG_PATH

      if (cmdOpts.global) {
        if (existsSync(globalCfg)) targets.push(globalCfg)
        else {
          console.log(`全局配置不存在: ${globalCfg}`)
          return
        }
      } else {
        if (existsSync(localCfg)) targets.push(localCfg)
        if (existsSync(globalCfg)) targets.push(globalCfg)
      }

      if (!targets.length) {
        console.log('未找到任何 config.json。请先运行: infiniti-agent init')
        return
      }

      for (const target of targets) {
        try {
          const result = await upgradeConfig(target)
          if (result.changed) {
            console.log(`\n✓ 已升级: ${target}`)
            for (const c of result.changes) {
              console.log(`  - ${c}`)
            }
          } else {
            console.log(`✓ ${target} — 已是最新格式，无需升级`)
          }
        } catch (e) {
          console.error(`✗ ${target}: ${(e as Error).message}`)
        }
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
      await withUiLogFile(cwd, () => runChatTui({ skipPermissions, disableThinking }))
    })

  program
    .command('live')
    .description('LiveUI：本地 WebSocket + Electron 透明渲染 + TUI（需 npm run build 生成 liveui/dist）')
    .option('-p, --port <port>', 'WebSocket 端口（覆盖 config.json 中 liveUi.port）')
    .option('--auto', '语音输入使用自动 VAD 模式；默认需按住空格录音，松开发送识别')
    .option(
      '--zoom <n>',
      '人物显示缩放（0.4 ~ 1.5；0.9 = 90%、0.8 = 80%；不影响控制条/输入框）',
    )
    .action(async (cmdOpts: { port?: string; zoom?: string; auto?: boolean }) => {
      await withUiLogFile(cwd, async () => {
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

      const explicitPort = cmdOpts.port?.trim()
      const port = explicitPort
        ? Number(explicitPort)
        : cfg.liveUi?.port ??
          (process.env.INFINITI_LIVEUI_PORT ? Number(process.env.INFINITI_LIVEUI_PORT) : 8080)

      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        console.error('无效端口，请使用 1–65535 之间的数字。')
        process.exit(2)
      }

      const spriteResolved = resolveSpriteExpressionDirForUi(cwd, cfg.liveUi)
      for (const w of spriteResolved?.warnings ?? []) {
        console.error(`[liveui] ${w}`)
      }

      const resolved = resolveLive2dModelForUi(cwd, cfg.liveUi)
      for (const w of resolved?.warnings ?? []) {
        console.error(`[liveui] ${w}`)
      }

      const useSprite = Boolean(spriteResolved?.dirFileUrl)
      const renderer = resolveLiveUiRenderer(cfg, useSprite)
      if (useSprite) {
        console.error(`[liveui] 已启用 spriteExpressions（PNG），不使用 Live2D 模型 URL`)
      }

      let figureZoom: number | undefined
      const zoomRaw = cmdOpts.zoom?.trim()
      if (zoomRaw) {
        const z = Number(zoomRaw)
        if (!Number.isFinite(z) || z < 0.4 || z > 1.5) {
          console.error('[live] --zoom 取值需在 0.4 ~ 1.5 之间，例如 0.9 表示 90%。')
          process.exit(2)
        }
        figureZoom = z
        console.error(`[liveui] 人物缩放: ${(z * 100).toFixed(0)}%`)
      }

      const liveUi = new LiveUiSession(port)
      await runChatTui({
        skipPermissions,
        disableThinking,
        liveUi,
        liveUiRenderer: renderer,
        liveUiModel3FileUrl: useSprite ? undefined : resolved?.model3FileUrl,
        liveUiSpriteExpressionDirFileUrl: spriteResolved?.dirFileUrl,
        liveUiVoiceMicJson: buildLiveUiVoiceMicEnvJson(cfg.liveUi, { auto: cmdOpts.auto === true }),
        liveUiReal2dJson: buildLiveUiReal2dEnvJson(cfg),
        liveUiFigureZoom: figureZoom,
        onConfigReload: async (nextCfg) => {
          if (nextCfg.liveUi?.port && nextCfg.liveUi.port !== liveUi.port) {
            console.warn(
              `[liveui] liveUi.port 已保存为 ${nextCfg.liveUi.port}，当前会话仍使用 ws://127.0.0.1:${liveUi.port}；端口变更需下次启动生效。`,
            )
          }
          await configureLiveUiEngines(liveUi, nextCfg)
          restartLiveUiElectron(liveUi, nextCfg, {
            auto: cmdOpts.auto === true,
            figureZoom,
          })
        },
      })
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
      if (!configExistsSync(cwd)) {
        console.error('尚未配置。请先运行: infiniti-agent init 或 infiniti-agent migrate')
        process.exit(2)
      }
      try {
        const cfg = applyThinkingOverride(await loadConfig(cwd), disableThinking)
        await runCliPrompt(cfg, prompt)
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
      '登录 LinkYun，选择 AI Agent，将 system prompt 写入 SOUL.md，并下载头像与角色设定到 .infiniti-agent/ref/<Agent Code>/',
    )
    .option(
      '--api-base <url>',
      'API 根地址（不含 /api/v1；省略时在终端询问，直接 Enter 为 https://api.linkyun.co）',
    )
    .option('--workspace <code>', '指定 X-Workspace-Code（默认使用登录接口返回的工作空间）')
    .action(async (cmd: { apiBase?: string; workspace?: string }) => {
      try {
        await runLinkyunSync(cwd, {
          apiBase: cmd.apiBase,
          workspaceCode: cmd.workspace,
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
