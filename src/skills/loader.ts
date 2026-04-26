import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { localSkillsDir, expandUserPath } from '../paths.js'
import { BUILTIN_SKILLS } from './builtin.js'

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

export async function loadSkillsForCwd(cwd: string): Promise<LoadedSkill[]> {
  const local = await loadSkillsFromDirs([localSkillsDir(cwd)])
  const seen = new Set(local.map((s) => s.id))
  return [
    ...local,
    ...BUILTIN_SKILLS.filter((s) => !seen.has(s.id)),
  ]
}

export function skillsToSystemBlock(skills: LoadedSkill[]): string {
  if (!skills.length) {
    return ''
  }
  const parts = skills.map(
    (s) => `### ${s.title} (\`${s.id}\`)\n\n${s.body}`,
  )
  return `## 已安装的 Skills\n\n${parts.join('\n\n---\n\n')}`
}
