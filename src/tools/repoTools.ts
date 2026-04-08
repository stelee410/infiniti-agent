import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import fg from 'fast-glob'
import type { EditHistory, EditSnapshot } from '../session/editHistory.js'
import { resolveWorkspacePath, isPathInsideWorkspace } from './workspacePaths.js'
import { fileUnifiedDiff, truncateDiffText } from './textDiff.js'

export type FileEditMeta = {
  editHistory?: EditHistory
}

const MAX_READ_BYTES = 512 * 1024
const MAX_WRITE_BYTES = 2 * 1024 * 1024
const DEFAULT_GLOB_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.next/**',
]
const MAX_GLOB_RESULTS = 400
const MAX_GREP_FILES = 250
const MAX_GREP_MATCHES = 120
const MAX_GREP_FILE_BYTES = 512 * 1024

/**
 * 兼容层：不再拦截 CLAUDE.md / AGENT.md 等路径，直接原样返回。
 * 保留函数签名以避免调用方报错。
 */
export function rewriteAgentPath(rel: string): { rel: string; rewritten: boolean } {
  return { rel, rewritten: false }
}

export function rewriteContentForAgent(content: string): string {
  return content
}

function jsonOk(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...data })
}

function jsonErr(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: false, error: message, ...extra })
}

export async function toolReadFile(
  sessionCwd: string,
  args: Record<string, unknown>,
): Promise<string> {
  const rel = String(args.path ?? '')
  let abs: string
  try {
    abs = resolveWorkspacePath(sessionCwd, rel)
  } catch (e) {
    return jsonErr(e instanceof Error ? e.message : String(e))
  }
  const startLine =
    typeof args.start_line === 'number' && args.start_line > 0
      ? Math.floor(args.start_line)
      : undefined
  const endLine =
    typeof args.end_line === 'number' && args.end_line > 0
      ? Math.floor(args.end_line)
      : undefined

  try {
    const stat = await fs.stat(abs)
    if (!stat.isFile()) {
      return jsonErr('不是普通文件', { path: rel })
    }
    if (stat.size > MAX_READ_BYTES && !startLine) {
      return jsonErr(
        `文件过大 (${stat.size} bytes)，上限 ${MAX_READ_BYTES}；请使用 start_line/end_line 分段读取`,
        { path: rel, size: stat.size },
      )
    }

    if (startLine != null) {
      const start = startLine
      const end = endLine ?? start + 999
      const lines: string[] = []
      let n = 0
      const stream = createReadStream(abs, { encoding: 'utf8' })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of rl) {
        n++
        if (n < start) {
          continue
        }
        if (n > end) {
          break
        }
        lines.push(line)
      }
      const content = lines.join('\n')
      return jsonOk({
        path: rel,
        start_line: start,
        end_line: end,
        line_count: lines.length,
        content,
      })
    }

    const buf = await fs.readFile(abs)
    if (buf.length > MAX_READ_BYTES) {
      return jsonErr(
        `文件过大 (${buf.length} bytes)，上限 ${MAX_READ_BYTES}`,
        { path: rel },
      )
    }
    const content = buf.toString('utf8')
    const lineCount = content.split(/\r?\n/).length
    return jsonOk({
      path: rel,
      line_count: lineCount,
      content,
    })
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return jsonErr('文件不存在', { path: rel })
    }
    return jsonErr(err.message ?? String(e), { path: rel })
  }
}

export async function toolGlobFiles(
  sessionCwd: string,
  args: Record<string, unknown>,
): Promise<string> {
  const pattern = String(args.pattern ?? '').trim()
  if (!pattern) {
    return jsonErr('pattern 不能为空')
  }
  const root = path.resolve(sessionCwd)
  const ignore = Array.isArray(args.ignore)
    ? (args.ignore as unknown[]).map((x) => String(x))
    : DEFAULT_GLOB_IGNORE
  try {
    const entries = await fg(pattern, {
      cwd: root,
      dot: Boolean(args.dot),
      onlyFiles: args.only_files !== false,
      ignore,
      absolute: false,
      followSymbolicLinks: false,
      stats: false,
    })
    const slice = entries.slice(0, MAX_GLOB_RESULTS)
    return jsonOk({
      pattern,
      count: entries.length,
      truncated: entries.length > slice.length,
      files: slice,
    })
  } catch (e: unknown) {
    return jsonErr(e instanceof Error ? e.message : String(e))
  }
}

function isBinaryPreview(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      return true
    }
  }
  return false
}

export async function toolGrepFiles(
  sessionCwd: string,
  args: Record<string, unknown>,
): Promise<string> {
  const patternStr = String(args.pattern ?? '')
  if (!patternStr.trim()) {
    return jsonErr('pattern 不能为空')
  }
  let regex: RegExp
  try {
    const flags = args.case_insensitive === true ? 'i' : ''
    regex = new RegExp(patternStr, flags)
  } catch {
    return jsonErr('无效的正则表达式 pattern')
  }
  const pathGlob = String(args.path_glob ?? '**/*').trim() || '**/*'
  const root = path.resolve(sessionCwd)
  const ignore = Array.isArray(args.ignore)
    ? (args.ignore as unknown[]).map((x) => String(x))
    : DEFAULT_GLOB_IGNORE
  const maxMatches =
    typeof args.max_matches === 'number'
      ? Math.min(500, Math.max(1, args.max_matches))
      : MAX_GREP_MATCHES

  let files: string[]
  try {
    files = await fg(pathGlob, {
      cwd: root,
      dot: false,
      onlyFiles: true,
      ignore,
      absolute: false,
      followSymbolicLinks: false,
    })
  } catch (e: unknown) {
    return jsonErr(e instanceof Error ? e.message : String(e))
  }

  const matches: Array<{
    file: string
    line: number
    text: string
  }> = []
  let filesScanned = 0

  for (const rel of files) {
    if (filesScanned >= MAX_GREP_FILES) {
      break
    }
    if (matches.length >= maxMatches) {
      break
    }
    const abs = path.join(root, rel)
    if (!isPathInsideWorkspace(root, abs)) {
      continue
    }
    filesScanned++
    let buf: Buffer
    try {
      buf = await fs.readFile(abs)
    } catch {
      continue
    }
    if (buf.length > MAX_GREP_FILE_BYTES || isBinaryPreview(buf)) {
      continue
    }
    let text: string
    try {
      text = buf.toString('utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxMatches) {
        break
      }
      const line = lines[i]!
      regex.lastIndex = 0
      if (regex.test(line)) {
        matches.push({ file: rel, line: i + 1, text: line.slice(0, 500) })
      }
      regex.lastIndex = 0
    }
  }

  return jsonOk({
    pattern: patternStr,
    path_glob: pathGlob,
    files_scanned: filesScanned,
    match_count: matches.length,
    truncated:
      matches.length >= maxMatches || filesScanned >= MAX_GREP_FILES,
    matches,
  })
}

export async function toolWriteFile(
  sessionCwd: string,
  args: Record<string, unknown>,
  meta?: FileEditMeta,
): Promise<string> {
  const rw = rewriteAgentPath(String(args.path ?? ''))
  const rel = rw.rel
  const rawContent = args.content != null ? String(args.content) : ''
  const content = rw.rewritten ? rewriteContentForAgent(rawContent) : rawContent
  const dryRun = args.dry_run === true
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    return jsonErr(`内容超过上限 ${MAX_WRITE_BYTES} bytes`)
  }
  let abs: string
  try {
    abs = resolveWorkspacePath(sessionCwd, rel)
  } catch (e) {
    return jsonErr(e instanceof Error ? e.message : String(e))
  }

  let previous: string | null = null
  try {
    const stat = await fs.stat(abs)
    if (stat.isDirectory()) {
      return jsonErr('路径是目录，不能作为文件写入', { path: rel })
    }
    if (!stat.isFile()) {
      return jsonErr('不是普通文件', { path: rel })
    }
    previous = await fs.readFile(abs, 'utf8')
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') {
      return jsonErr(err.message ?? String(e), { path: rel })
    }
  }

  if (dryRun) {
    const patch = fileUnifiedDiff(rel, previous ?? '', content)
    return jsonOk({
      dry_run: true,
      path: rel,
      diff: truncateDiffText(patch),
      ...(rw.rewritten ? { rewritten_from: String(args.path ?? '') } : {}),
    })
  }

  try {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    if (meta?.editHistory) {
      meta.editHistory.push({ relPath: rel, previous })
    }
    return jsonOk({
      path: rel,
      bytes: Buffer.byteLength(content, 'utf8'),
      ...(rw.rewritten ? { rewritten_from: String(args.path ?? '') } : {}),
    })
  } catch (e: unknown) {
    return jsonErr(e instanceof Error ? e.message : String(e), {
      path: rel,
    })
  }
}

export async function restoreEditSnapshot(
  sessionCwd: string,
  snap: EditSnapshot,
): Promise<string> {
  let abs: string
  try {
    abs = resolveWorkspacePath(sessionCwd, snap.relPath)
  } catch (e) {
    return jsonErr(e instanceof Error ? e.message : String(e))
  }
  try {
    if (snap.previous === null) {
      await fs.unlink(abs)
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, snap.previous, 'utf8')
    }
    return jsonOk({ path: snap.relPath, restored: true })
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    return jsonErr(err.message ?? String(e), { path: snap.relPath })
  }
}

export function computeStrReplaceNext(
  raw: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
):
  | { ok: true; next: string; count: number }
  | { ok: false; error: string; occurrences?: number } {
  if (!oldStr) {
    return {
      ok: false,
      error: 'old_string 不能为空（请用 write_file 创建空文件或整文件写入）',
    }
  }
  const count = raw.split(oldStr).length - 1
  if (count === 0) {
    return { ok: false, error: '未找到 old_string，未作修改' }
  }
  if (!replaceAll && count !== 1) {
    return {
      ok: false,
      error: `old_string 出现 ${count} 次；请扩大上下文唯一匹配，或设 replace_all=true`,
      occurrences: count,
    }
  }
  const next = replaceAll
    ? raw.split(oldStr).join(newStr)
    : raw.replace(oldStr, newStr)
  return { ok: true, next, count: replaceAll ? count : 1 }
}

export async function toolStrReplace(
  sessionCwd: string,
  args: Record<string, unknown>,
  meta?: FileEditMeta,
): Promise<string> {
  const rw = rewriteAgentPath(String(args.path ?? ''))
  const rel = rw.rel
  const oldStr = args.old_string != null ? String(args.old_string) : ''
  const rawNewStr = args.new_string != null ? String(args.new_string) : ''
  const newStr = rw.rewritten ? rewriteContentForAgent(rawNewStr) : rawNewStr
  const dryRun = args.dry_run === true
  const replaceAll = args.replace_all === true
  let abs: string
  try {
    abs = resolveWorkspacePath(sessionCwd, rel)
  } catch (e) {
    return jsonErr(e instanceof Error ? e.message : String(e))
  }
  try {
    const stat = await fs.stat(abs)
    if (!stat.isFile()) {
      return jsonErr('不是普通文件', { path: rel })
    }
    const raw = await fs.readFile(abs, 'utf8')
    const pr = computeStrReplaceNext(raw, oldStr, newStr, replaceAll)
    if (!pr.ok) {
      return jsonErr(pr.error, {
        path: rel,
        ...(pr.occurrences != null ? { occurrences: pr.occurrences } : {}),
      })
    }
    if (dryRun) {
      const patch = fileUnifiedDiff(rel, raw, pr.next)
      return jsonOk({
        dry_run: true,
        path: rel,
        diff: truncateDiffText(patch),
      })
    }
    if (Buffer.byteLength(pr.next, 'utf8') > MAX_WRITE_BYTES) {
      return jsonErr(`替换后超过 ${MAX_WRITE_BYTES} bytes`)
    }
    await fs.writeFile(abs, pr.next, 'utf8')
    if (meta?.editHistory) {
      meta.editHistory.push({ relPath: rel, previous: raw })
    }
    return jsonOk({
      path: rel,
      replacements: pr.count,
      bytes: Buffer.byteLength(pr.next, 'utf8'),
      ...(rw.rewritten ? { rewritten_from: String(args.path ?? '') } : {}),
    })
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return jsonErr('文件不存在', { path: rel })
    }
    return jsonErr(err.message ?? String(e), { path: rel })
  }
}

export async function toolListDirectory(
  sessionCwd: string,
  args: Record<string, unknown>,
): Promise<string> {
  const rel = String(args.path ?? '.')
  let abs: string
  try {
    abs = resolveWorkspacePath(sessionCwd, rel)
  } catch (e) {
    return jsonErr(e instanceof Error ? e.message : String(e))
  }
  try {
    const stat = await fs.stat(abs)
    if (!stat.isDirectory()) {
      return jsonErr('不是目录', { path: rel })
    }
    const names = await fs.readdir(abs, { withFileTypes: true })
    const entries = names.map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
    }))
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
    return jsonOk({ path: rel, entries })
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return jsonErr('目录不存在', { path: rel })
    }
    return jsonErr(err.message ?? String(e), { path: rel })
  }
}
