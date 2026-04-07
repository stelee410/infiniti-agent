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

async function runChatTui(): Promise<void> {
  if (!configExistsSync()) {
    const { waitUntilExit } = render(<InitWizard />)
    await waitUntilExit()
    return
  }
  let cfg
  try {
    cfg = await loadConfig()
  } catch (e) {
    console.error((e as Error).message)
    const { waitUntilExit } = render(<InitWizard />)
    await waitUntilExit()
    return
  }
  const mcp = new McpManager()
  try {
    await mcp.start(cfg)
    const { waitUntilExit } = render(<ChatWithSplash config={cfg} mcp={mcp} />)
    await waitUntilExit()
  } finally {
    await mcp.stop()
  }
}

async function main(): Promise<void> {
  if (process.argv.slice(2).length === 0) {
    process.argv.push('chat')
  }

  const program = new Command()
  program
    .name('infiniti-agent')
    .description('LinkYun Infiniti Agent — React + Ink TUI')
    .version('0.0.1')

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
      await runChatTui()
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
