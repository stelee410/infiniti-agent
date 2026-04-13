import { mkdir, readFile, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { localSkillsDir } from '../paths.js'

export type SkillAction =
  | { action: 'create'; name: string; content: string }
  | { action: 'patch'; name: string; old_string: string; new_string: string }
  | { action: 'delete'; name: string }

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64)
}

export async function executeSkillAction(
  cwd: string,
  act: SkillAction,
): Promise<{ ok: boolean; message?: string; error?: string; path?: string }> {
  const safeName = sanitizeName(act.name)
  if (!safeName) {
    return { ok: false, error: 'Skill 名称无效' }
  }
  const skillDir = join(localSkillsDir(cwd), safeName)
  const skillPath = join(skillDir, 'SKILL.md')

  if (act.action === 'create') {
    if (!act.content?.trim()) {
      return { ok: false, error: 'content 不能为空' }
    }
    await mkdir(skillDir, { recursive: true })
    await writeFile(skillPath, act.content, 'utf8')
    return { ok: true, message: `已创建 Skill「${safeName}」`, path: skillPath }
  }

  if (act.action === 'patch') {
    if (!act.old_string || !act.new_string) {
      return { ok: false, error: 'patch 操作需要 old_string 和 new_string' }
    }
    let existing: string
    try {
      existing = await readFile(skillPath, 'utf8')
    } catch {
      return { ok: false, error: `Skill「${safeName}」不存在` }
    }
    const count = existing.split(act.old_string).length - 1
    if (count === 0) {
      return { ok: false, error: 'old_string 在 SKILL.md 中未找到' }
    }
    if (count > 1) {
      return { ok: false, error: `old_string 在 SKILL.md 中出现 ${count} 次，请提供更精确的片段` }
    }
    const updated = existing.replace(act.old_string, act.new_string)
    await writeFile(skillPath, updated, 'utf8')
    return { ok: true, message: `已更新 Skill「${safeName}」`, path: skillPath }
  }

  if (act.action === 'delete') {
    try {
      await rm(skillDir, { recursive: true, force: true })
    } catch {
      return { ok: false, error: `删除 Skill「${safeName}」失败` }
    }
    return { ok: true, message: `已删除 Skill「${safeName}」` }
  }

  return { ok: false, error: '未知 action' }
}
