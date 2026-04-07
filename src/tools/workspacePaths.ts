import path from 'node:path'

/** 判断 target 是否位于 root 目录内（含 root 自身） */
export function isPathInsideWorkspace(root: string, target: string): boolean {
  const r = path.resolve(root)
  const t = path.resolve(target)
  const rel = path.relative(r, t)
  if (rel === '') {
    return true
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return false
  }
  return true
}

/**
 * 将用户给出的路径解析为绝对路径，且必须落在 sessionCwd 之下。
 * 允许相对路径；绝对路径若不在工作区内则拒绝。
 */
export function resolveWorkspacePath(
  sessionCwd: string,
  userPath: string,
): string {
  const root = path.resolve(sessionCwd)
  const trimmed = userPath.trim()
  if (!trimmed) {
    throw new Error('路径不能为空')
  }
  const resolved = path.resolve(root, trimmed)
  if (!isPathInsideWorkspace(root, resolved)) {
    throw new Error(`路径必须位于工作区内: ${root}`)
  }
  return resolved
}
