import { readFile } from 'node:fs/promises'
import { computeStrReplaceNext } from '../tools/repoTools.js'
import { fileUnifiedDiff, truncateDiffText } from '../tools/textDiff.js'
import { resolveWorkspacePath } from '../tools/workspacePaths.js'

const CONFIRM_DIFF_MAX = 14 * 1024

export const CONFIRMABLE_BUILTIN_TOOLS = new Set<string>([
  'write_file',
  'str_replace',
  'bash',
  'http_request',
])

export async function formatToolConfirmDetail(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  if (name === 'bash') {
    const cmd = String(args.command ?? '').trim()
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '.'
    const shown = cmd.length > 4000 ? `${cmd.slice(0, 4000)}\n…` : cmd
    return `${shown}\n[cwd] ${cwd}`
  }
  if (name === 'http_request') {
    return `${String(args.method ?? 'GET')} ${String(args.url ?? '')}`
  }
  if (name === 'write_file') {
    const rel = String(args.path ?? '')
    const content = String(args.content ?? '')
    let abs: string
    try {
      abs = resolveWorkspacePath(cwd, rel)
    } catch (e) {
      return `路径无效: ${rel}\n${e instanceof Error ? e.message : String(e)}`
    }
    let old = ''
    try {
      old = await readFile(abs, 'utf8')
    } catch {
      old = ''
    }
    const patch = fileUnifiedDiff(rel, old, content)
    return truncateDiffText(patch, CONFIRM_DIFF_MAX)
  }
  if (name === 'str_replace') {
    const rel = String(args.path ?? '')
    const oldStr = args.old_string != null ? String(args.old_string) : ''
    const newStr = args.new_string != null ? String(args.new_string) : ''
    const replaceAll = args.replace_all === true
    let abs: string
    try {
      abs = resolveWorkspacePath(cwd, rel)
    } catch (e) {
      return `路径无效: ${rel}\n${e instanceof Error ? e.message : String(e)}`
    }
    let raw: string
    try {
      raw = await readFile(abs, 'utf8')
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException
      return `无法读取文件: ${rel} (${err.code ?? err.message})`
    }
    const pr = computeStrReplaceNext(raw, oldStr, newStr, replaceAll)
    if (!pr.ok) {
      return `${rel}\n替换预览失败: ${pr.error}`
    }
    const patch = fileUnifiedDiff(rel, raw, pr.next)
    return truncateDiffText(patch, CONFIRM_DIFF_MAX)
  }
  return JSON.stringify(args).slice(0, 2000)
}
