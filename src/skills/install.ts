import { mkdir, cp, readdir, rm } from 'fs/promises'
import { join, basename } from 'path'
import { spawn } from 'child_process'
import { SKILLS_DIR } from '../paths.js'
import { ensureInfinitiDir } from '../config/io.js'

function runGit(args: string[], cwd?: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })
}

function inferNameFromGitUrl(url: string): string {
  try {
    const u = new URL(url)
    const base = basename(u.pathname.replace(/\.git$/i, ''))
    return base.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'skill'
  } catch {
    return 'skill'
  }
}

export async function installSkillFromGit(url: string): Promise<string> {
  await ensureInfinitiDir()
  await mkdir(SKILLS_DIR, { recursive: true, mode: 0o700 })
  const tmp = join(SKILLS_DIR, `.tmp-${Date.now()}`)
  await mkdir(tmp, { recursive: true })
  const code = await runGit(['clone', '--depth', '1', url, 'repo'], tmp)
  if (code !== 0) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw new Error(`git clone 失败，退出码 ${code ?? 'unknown'}`)
  }
  const repoDir = join(tmp, 'repo')
  const entries = await readdir(repoDir, { withFileTypes: true })
  const hasSkillMd = entries.some((e) => e.isFile() && e.name === 'SKILL.md')
  const targetName = inferNameFromGitUrl(url)
  const dest = join(SKILLS_DIR, targetName)
  await cp(repoDir, dest, { recursive: true, force: true })
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
  if (!hasSkillMd) {
    return `${dest}\n(警告: 仓库根目录未找到 SKILL.md，请手动补充以被加载)`
  }
  return dest
}

export async function installSkillFromPath(localPath: string): Promise<string> {
  await ensureInfinitiDir()
  await mkdir(SKILLS_DIR, { recursive: true, mode: 0o700 })
  const src = localPath.trim()
  const name = basename(src).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'skill'
  const dest = join(SKILLS_DIR, name)
  await cp(src, dest, { recursive: true, force: true })
  return dest
}
