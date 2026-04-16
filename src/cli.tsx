#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { Command } from 'commander'
import { existsSync } from 'fs'
import { cp, mkdir } from 'fs/promises'
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
import { createWhisperAsr } from './asr/whisperAsr.js'
import { createSherpaOnnxAsr } from './asr/sherpaOnnxAsr.js'
import { spawnLiveElectron } from './liveui/spawnRenderer.js'
import { buildLiveUiVoiceMicEnvJson, VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD } from './liveui/voiceMicEnv.js'
import { runTestAsr, parseTestAsrRms, parseTestAsrInt } from './cli/testAsr.js'
import { resolveLive2dModelForUi, resolveSpriteExpressionDirForUi } from './liveui/resolveModelPath.js'
import { runAddLlm, runSelectLlm } from './cli/llmCli.js'

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

async function runChatTui(
  opts: {
    skipPermissions?: boolean
    disableThinking?: boolean
    liveUi?: LiveUiSession | null
    liveUiModel3FileUrl?: string
    /** `live` 且配置了 `spriteExpressions.dir` 时注入 Electron（`INFINITI_LIVEUI_SPRITE_EXPRESSION_DIR`） */
    liveUiSpriteExpressionDirFileUrl?: string
    /** `live` 时注入麦克 VAD（JSON → Electron `INFINITI_LIVEUI_VOICE_MIC`） */
    liveUiVoiceMicJson?: string
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
      if (cfg.tts?.provider === 'minimax') {
        liveUi.setTtsEngine(createMinimaxTts(cfg.tts))
        console.error(`[liveui] MiniMax TTS 已启用 (model: ${cfg.tts.model ?? 'speech-02-turbo'}, voice: ${cfg.tts.voiceId ?? 'female-shaonv'})`)
      }
      if (cfg.asr?.provider === 'whisper') {
        liveUi.setAsrEngine(createWhisperAsr(cfg.asr))
        console.error(`[liveui] Whisper ASR 已启用 (model: ${cfg.asr.model ?? 'whisper-large-v3-turbo'}, baseUrl: ${cfg.asr.baseUrl})`)
      } else if (cfg.asr?.provider === 'sherpa_onnx') {
        liveUi.setAsrEngine(await createSherpaOnnxAsr(cfg.asr))
        console.error(`[liveui] sherpa-onnx ASR 已启用 (model: ${cfg.asr.model})`)
      }
      const child = spawnLiveElectron(liveUi.port, {
        model3FileUrl: opts.liveUiModel3FileUrl,
        spriteExpressionDirFileUrl: opts.liveUiSpriteExpressionDirFileUrl,
        voiceMicJson: opts.liveUiVoiceMicJson,
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
      await runChatTui({ skipPermissions, disableThinking })
    })

  program
    .command('live')
    .description('LiveUI：本地 WebSocket + Electron 透明渲染 + TUI（需 npm run build 生成 liveui/dist）')
    .option('-p, --port <port>', 'WebSocket 端口（覆盖 config.json 中 liveUi.port）')
    .action(async (cmdOpts: { port?: string }) => {
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
      if (useSprite) {
        console.error(`[liveui] 已启用 spriteExpressions（PNG），不使用 Live2D 模型 URL`)
      }

      const liveUi = new LiveUiSession(port)
      await runChatTui({
        skipPermissions,
        disableThinking,
        liveUi,
        liveUiModel3FileUrl: useSprite ? undefined : resolved?.model3FileUrl,
        liveUiSpriteExpressionDirFileUrl: spriteResolved?.dirFileUrl,
        liveUiVoiceMicJson: buildLiveUiVoiceMicEnvJson(cfg.liveUi),
      })
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
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
