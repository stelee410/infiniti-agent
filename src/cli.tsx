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
import { spawnLiveElectron } from './liveui/spawnRenderer.js'

const cwd = process.cwd()

function applyThinkingOverride(cfg: Awaited<ReturnType<typeof loadConfig>>, disable: boolean): Awaited<ReturnType<typeof loadConfig>> {
  if (!disable) return cfg
  return { ...cfg, thinking: { ...cfg.thinking, mode: 'disabled' as const } }
}

async function runChatTui(
  opts: { skipPermissions?: boolean; disableThinking?: boolean; liveUi?: LiveUiSession | null } = {},
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
      await liveUi.start()
      liveUi.startMouthPump()
      const child = spawnLiveElectron(liveUi.port)
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
    .command('chat')
    .description('进入对话界面（无参数时默认）')
    .action(async () => {
      await runChatTui({ skipPermissions, disableThinking })
    })

  program
    .command('live')
    .description('LiveUI：本地 WebSocket + Electron 透明渲染 + TUI（需 npm run build 生成 liveui/dist）')
    .option('-p, --port <port>', 'WebSocket 端口', process.env.INFINITI_LIVEUI_PORT ?? '8080')
    .action(async (cmdOpts: { port?: string }) => {
      const port = Number(cmdOpts.port ?? '8080')
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        console.error('无效端口，请使用 1–65535 之间的数字。')
        process.exit(2)
      }
      if (!configExistsSync(cwd)) {
        console.error('尚未配置。请先运行: infiniti-agent init 或 infiniti-agent migrate')
        process.exit(2)
      }
      const liveUi = new LiveUiSession(port)
      await runChatTui({ skipPermissions, disableThinking, liveUi })
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
