import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { SKILLS_DIR, expandUserPath } from '../paths.js'
import type { InfinitiConfig } from '../config/types.js'

export type LoadedSkill = {
  id: string
  title: string
  body: string
  path: string
}

async function readSkillMd(dir: string, id: string): Promise<LoadedSkill | null> {
  const p = join(dir, id, 'SKILL.md')
  try {
    const s = await stat(p)
    if (!s.isFile()) {
      return null
    }
  } catch {
    return null
  }
  const raw = await readFile(p, 'utf8')
  const lines = raw.split(/\r?\n/)
  let title = id
  let start = 0
  if (lines[0]?.startsWith('# ')) {
    title = lines[0].slice(2).trim() || id
    start = 1
  }
  const body = lines.slice(start).join('\n').trim()
  return { id, title, body, path: p }
}

export async function loadSkillsFromDirs(
  dirs: string[],
): Promise<LoadedSkill[]> {
  const out: LoadedSkill[] = []
  const seen = new Set<string>()
  for (const d of dirs) {
    const root = expandUserPath(d.trim())
    let names: string[]
    try {
      names = await readdir(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (seen.has(name)) {
        continue
      }
      const skill = await readSkillMd(root, name)
      if (skill) {
        seen.add(name)
        out.push(skill)
      }
    }
  }
  return out
}

export async function loadSkillsForConfig(
  cfg: InfinitiConfig | null,
): Promise<LoadedSkill[]> {
  const dirs =
    cfg?.skills?.directories?.length
      ? cfg.skills.directories
      : [SKILLS_DIR]
  return loadSkillsFromDirs(dirs)
}

export function skillsToSystemBlock(skills: LoadedSkill[]): string {
  if (!skills.length) {
    return ''
  }
  const parts = skills.map(
    (s) => `### ${s.title} (\`${s.id}\`)\n\n${s.body}`,
  )
  return `## 已安装的 Skills（第三方）\n\n${parts.join('\n\n---\n\n')}`
}
