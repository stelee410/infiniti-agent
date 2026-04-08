#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { Command } from 'commander'
import { existsSync } from 'fs'
import { configExistsSync, loadConfig, ensureInfinitiDir } from './config/io.js'
import { InitWizard } from './ui/InitWizard.js'
import { ChatWithSplash } from './ui/ChatWithSplash.js'
import { McpManager } from './mcp/manager.js'
import { installSkillFromGit, installSkillFromPath } from './skills/install.js'
import { loadSkillsFromDirs } from './skills/loader.js'
import { SKILLS_DIR, expandUserPath } from './paths.js'
import { runCliPrompt } from './runCliPrompt.js'
import { readPackageVersion } from './packageRoot.js'

function applyThinkingOverride(cfg: Awaited<ReturnType<typeof loadConfig>>, disable: boolean): Awaited<ReturnType<typeof loadConfig>> {
  if (!disable) return cfg
  return { ...cfg, thinking: { ...cfg.thinking, mode: 'disabled' as const } }
}

async function runChatTui(opts: { skipPermissions?: boolean; disableThinking?: boolean } = {}): Promise<void> {
  if (!configExistsSync()) {
    const { waitUntilExit } = render(<InitWizard />)
    await waitUntilExit()
    return
  }
  let cfg
  try {
    cfg = applyThinkingOverride(await loadConfig(), opts.disableThinking ?? false)
  } catch (e) {
    console.error((e as Error).message)
    const { waitUntilExit } = render(<InitWizard />)
    await waitUntilExit()
    return
  }
  const mcp = new McpManager()
  try {
    await mcp.start(cfg)
    const skipPerm = opts.skipPermissions ?? false
    const { waitUntilExit } = render(
      <ChatWithSplash config={cfg} mcp={mcp} dangerouslySkipPermissions={skipPerm} />,
    )
    await waitUntilExit()
  } finally {
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
    if (!configExistsSync()) {
      console.error('尚未配置。请先运行: infiniti-agent init')
      process.exit(2)
    }
    try {
      const cfg = applyThinkingOverride(await loadConfig(), disableThinking)
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
      'LinkYun Infiniti Agent — React + Ink TUI。非交互一轮：infiniti-agent cli <prompt>。加 --disable-thinking 禁用深度思考。加 --dangerously-skip-permissions 跳过安全评估。加 --debug 输出 meta-agent 日志到 stderr。',
    )
    .version(readPackageVersion())

  program
    .command('init')
    .description('配置 LLM（provider / base URL / model / api key）')
    .action(async () => {
      const { waitUntilExit } = render(<InitWizard />)
      await waitUntilExit()
    })

  program
    .command('chat')
    .description('进入对话界面（无参数时默认）')
    .action(async () => {
      await runChatTui({ skipPermissions, disableThinking })
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
      if (!configExistsSync()) {
        console.error('尚未配置。请先运行: infiniti-agent init')
        process.exit(2)
      }
      try {
        const cfg = applyThinkingOverride(await loadConfig(), disableThinking)
        await runCliPrompt(cfg, prompt)
      } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
      }
    })

  const skill = program.command('skill').description('第三方 Skills')

  skill
    .command('install <source>')
    .description('从 git URL 或本地路径安装到 ~/.infiniti-agent/skills/<name>')
    .action(async (source: string) => {
      await ensureInfinitiDir()
      const s = source.trim()
      let dest: string
      if (/^https?:\/\//i.test(s) || s.startsWith('git@')) {
        dest = await installSkillFromGit(s)
      } else {
        const p = expandUserPath(s)
        if (!existsSync(p)) {
          console.error('路径不存在。请提供可读的本地目录或 git URL。')
          process.exitCode = 1
          return
        }
        dest = await installSkillFromPath(p)
      }
      console.log(dest)
    })

  skill
    .command('list')
    .description('列出 ~/.infiniti-agent/skills 下的 Skills（需含 SKILL.md）')
    .action(async () => {
      const skills = await loadSkillsFromDirs([SKILLS_DIR])
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
