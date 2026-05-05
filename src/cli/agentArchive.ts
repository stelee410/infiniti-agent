import JSZip from 'jszip'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

const MANIFEST_NAME = '.infiniti-agent-export.json'

const AGENT_LAYOUT_ROOTS = [
  '.infiniti-agent',
  'SOUL.md',
  'AGENTS.md',
  'AGENT.md',
  'INFINITI.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
] as const

const LOCAL_ONLY_PREFIXES = [
  '.infiniti-agent/inbox/assets/',
  '.infiniti-agent/backups/',
  '.infiniti-agent/tmp/',
] as const

const LOCAL_ONLY_FILES = [
  '.env.local',
] as const

export type AgentArchiveResult = {
  archivePath: string
  entries: string[]
}

function archivePath(cwd: string, outPath: string): string {
  return isAbsolute(outPath) ? outPath : join(cwd, outPath)
}

function toZipPath(path: string): string {
  return path.split(sep).join('/')
}

function hasAgentLayout(cwd: string): boolean {
  return AGENT_LAYOUT_ROOTS.some((entry) => existsSync(join(cwd, entry)))
}

function shouldSkipArchiveEntry(relPath: string): boolean {
  const p = toZipPath(relPath)
  if (LOCAL_ONLY_FILES.includes(p as typeof LOCAL_ONLY_FILES[number])) return true
  if (LOCAL_ONLY_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix))) return true
  if (p.endsWith('.agent')) return true
  if (p.startsWith('.infiniti-agent/') && p.endsWith('.log')) return true
  return false
}

async function collectFiles(cwd: string, relPath: string, out: string[]): Promise<void> {
  if (shouldSkipArchiveEntry(relPath)) return
  const fullPath = join(cwd, relPath)
  const s = await stat(fullPath)
  if (s.isDirectory()) {
    const children = await readdir(fullPath)
    if (!children.length) out.push(toZipPath(relPath) + '/')
    for (const child of children) {
      await collectFiles(cwd, join(relPath, child), out)
    }
    return
  }
  if (s.isFile()) out.push(toZipPath(relPath))
}

async function collectAgentLayoutEntries(cwd: string): Promise<string[]> {
  const entries: string[] = []
  for (const root of AGENT_LAYOUT_ROOTS) {
    if (existsSync(join(cwd, root))) {
      await collectFiles(cwd, root, entries)
    }
  }
  return [...new Set(entries)].sort((a, b) => a.localeCompare(b))
}

async function addEntry(zip: JSZip, cwd: string, entry: string): Promise<void> {
  if (entry.endsWith('/')) {
    zip.folder(entry)
    return
  }
  const fullPath = join(cwd, ...entry.split('/'))
  const s = await stat(fullPath)
  const data = await readFile(fullPath)
  zip.file(entry, data, {
    date: s.mtime,
    unixPermissions: s.mode & 0o777,
  })
}

export async function exportAgentArchive(cwd: string, outPath: string): Promise<AgentArchiveResult> {
  const entries = await collectAgentLayoutEntries(cwd)
  if (!entries.length) {
    throw new Error('当前目录没有可导出的 agent layout（未找到 .infiniti-agent/ 或 SOUL.md 等文件）')
  }

  const zip = new JSZip()
  zip.file(
    MANIFEST_NAME,
    JSON.stringify(
      {
        format: 'infiniti-agent.archive',
        version: 1,
        createdAt: new Date().toISOString(),
        entries,
      },
      null,
      2,
    ) + '\n',
  )
  for (const entry of entries) {
    await addEntry(zip, cwd, entry)
  }

  const target = archivePath(cwd, outPath)
  await mkdir(dirname(target), { recursive: true })
  const data = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: process.platform === 'win32' ? 'DOS' : 'UNIX',
  })
  await writeFile(target, data)
  return { archivePath: target, entries }
}

function safeArchiveEntryPath(name: string): string | null {
  const normalized = normalize(name.replace(/\\/g, '/'))
  if (!normalized || normalized === '.' || normalized.startsWith('..') || isAbsolute(normalized)) {
    return null
  }
  if (/^[a-zA-Z]:/.test(normalized)) return null
  return normalized.split(sep).join('/')
}

function originalArchiveEntryName(file: JSZip.JSZipObject): string {
  return (file as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? file.name
}

async function confirmOverwrite(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question('当前目录已存在 agent layout，是否覆盖？输入 yes 确认: ')
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

async function clearExistingAgentLayout(cwd: string): Promise<void> {
  for (const entry of AGENT_LAYOUT_ROOTS) {
    if (entry === '.infiniti-agent') {
      if (!existsSync(join(cwd, entry))) continue
      await clearAgentDirForImport(cwd)
    } else {
      await rm(join(cwd, entry), { recursive: true, force: true })
    }
  }
}

async function clearAgentDirForImport(cwd: string): Promise<void> {
  const root = join(cwd, '.infiniti-agent')
  const children = await readdir(root)
  for (const child of children) {
    const rel = toZipPath(join('.infiniti-agent', child))
    if (LOCAL_ONLY_PREFIXES.some((prefix) => rel === prefix.split('/')[1] || rel === prefix.slice(0, -1))) {
      continue
    }
    if (rel === '.infiniti-agent/inbox') {
      await clearInboxForImport(cwd)
      continue
    }
    await rm(join(root, child), { recursive: true, force: true })
  }
}

async function clearInboxForImport(cwd: string): Promise<void> {
  const inbox = join(cwd, '.infiniti-agent', 'inbox')
  if (!existsSync(inbox)) return
  const children = await readdir(inbox)
  for (const child of children) {
    if (child === 'assets') continue
    await rm(join(inbox, child), { recursive: true, force: true })
  }
}

async function restoreMode(path: string, mode: number | string | null | undefined): Promise<void> {
  if (typeof mode !== 'number') return
  await chmod(path, mode & 0o777).catch(() => {})
}

export async function importAgentArchive(
  cwd: string,
  inPath: string,
  opts: { force?: boolean } = {},
): Promise<AgentArchiveResult & { overwritten: boolean }> {
  const source = archivePath(cwd, inPath)
  const zip = await JSZip.loadAsync(await readFile(source))
  const entries = Object.values(zip.files)
    .map((entry) => safeArchiveEntryPath(originalArchiveEntryName(entry)))
    .filter((entry): entry is string => !!entry && entry !== MANIFEST_NAME)
    .sort((a, b) => a.localeCompare(b))

  if (!entries.length) {
    throw new Error('归档文件中没有可导入的 agent layout')
  }

  const existing = hasAgentLayout(cwd)
  if (existing && !opts.force) {
    const ok = await confirmOverwrite()
    if (!ok) throw new Error('已取消导入。未覆盖当前目录的 agent layout。')
  }
  if (existing) await clearExistingAgentLayout(cwd)

  const cwdRoot = normalize(cwd)
  for (const file of Object.values(zip.files)) {
    const originalName = originalArchiveEntryName(file)
    const rel = safeArchiveEntryPath(originalName)
    if (!rel) throw new Error(`归档包含不安全路径: ${originalName}`)
    if (rel === MANIFEST_NAME) continue
    const target = join(cwd, ...rel.split('/'))
    const normalizedTarget = normalize(target)
    const targetRel = relative(cwdRoot, normalizedTarget)
    if (targetRel === '..' || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) {
      throw new Error(`归档包含不安全路径: ${originalName}`)
    }
    if (file.dir) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await file.async('nodebuffer'))
    await restoreMode(target, file.unixPermissions)
  }

  return { archivePath: source, entries, overwritten: existing }
}
