import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { localAgentDir } from '../paths.js'
import type { SubconsciousMemoryEntry, SubconsciousStore } from '../subconscious/types.js'

const DOC_DIR = join('memory', 'long-term')
const DOC_VERSION = 1

export type DocumentMemoryHit = {
  id: string
  kind: 'longTerm' | 'fuzzy'
  title: string
  text: string
  confidence: number
  reinforcement: number
  topic?: string
  source: string
  score: number
}

type DocumentMemoryIndex = {
  version: 1
  updatedAt: string
  entries: Array<{
    id: string
    kind: 'longTerm' | 'fuzzy'
    file: string
    title: string
    topic?: string
    tags: string[]
    aliases: string[]
    confidence: number
    reinforcement: number
    lastSeenAt: string
  }>
}

type ParsedDocEntry = DocumentMemoryIndex['entries'][number] & {
  text: string
}

export function documentMemoryDir(cwd: string): string {
  return join(localAgentDir(cwd), DOC_DIR)
}

export async function syncDocumentMemory(cwd: string, store: SubconsciousStore): Promise<void> {
  const dir = documentMemoryDir(cwd)
  await mkdir(dir, { recursive: true })
  const parsedEntries: ParsedDocEntry[] = []
  const docs: Array<{ name: string; entries: Array<{ kind: 'longTerm' | 'fuzzy'; entry: SubconsciousMemoryEntry }> }> = [
    { name: 'long-term.md', entries: store.memory.longTerm.map((entry) => ({ kind: 'longTerm' as const, entry })) },
    { name: 'fuzzy.md', entries: store.memory.fuzzy.map((entry) => ({ kind: 'fuzzy' as const, entry })) },
  ]
  const index: DocumentMemoryIndex = { version: DOC_VERSION, updatedAt: new Date().toISOString(), entries: [] }
  for (const doc of docs) {
    const body = renderDocument(doc.name, doc.entries)
    await writeFile(join(dir, doc.name), body, 'utf8')
    parsedEntries.push(...parseDocument(doc.name, body))
    for (const item of doc.entries) {
      index.entries.push(toIndexEntry(doc.name, item.kind, item.entry))
    }
  }
  await writeFile(join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')
  rebuildDocumentMemoryFts(dir, parsedEntries)
}

export async function retrieveDocumentMemories(cwd: string, query: string, limit = 6): Promise<DocumentMemoryHit[]> {
  const terms = extractSearchTerms(query)
  if (terms.length === 0) return []
  const entries = await loadDocumentEntries(cwd)
  const fts = searchDocumentMemoryFts(documentMemoryDir(cwd), terms, limit)
  if (fts.length > 0) return fts
  const exact = rankEntries(entries, terms, false)
  const ranked = exact.length > 0 ? exact : rankEntries(entries, expandTerms(terms, entries), true)
  return ranked.slice(0, limit)
}

export function documentMemoryHitsToPromptBlock(hits: DocumentMemoryHit[]): string {
  if (hits.length === 0) return ''
  const lines = hits.map((hit) => {
    const topic = hit.topic ? ` topic=${hit.topic}` : ''
    return `- [${hit.kind} confidence=${hit.confidence.toFixed(2)} reinforcement=${hit.reinforcement}${topic}] ${hit.title}\n  ${hit.text}`
  })
  return `## 相关长期记忆（按当前主题检索）\n${lines.join('\n')}`
}

async function loadDocumentEntries(cwd: string): Promise<ParsedDocEntry[]> {
  const dir = documentMemoryDir(cwd)
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith('.md'))
    const out: ParsedDocEntry[] = []
    for (const file of files) {
      const raw = await readFile(join(dir, file), 'utf8')
      out.push(...parseDocument(file, raw))
    }
    return out
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return []
    throw e
  }
}

function renderDocument(
  title: string,
  entries: Array<{ kind: 'longTerm' | 'fuzzy'; entry: SubconsciousMemoryEntry }>,
): string {
  const lines = [
    `# ${title.replace(/\.md$/, '')}`,
    '',
    '<!-- Managed by subconscious-agent. Edit text cautiously; ids are used for reinforcement. -->',
    '',
  ]
  for (const { kind, entry } of entries) {
    lines.push(`## ${entry.text.slice(0, 48)}`)
    lines.push(`id: ${entry.id}`)
    lines.push(`kind: ${kind}`)
    lines.push(`topic: ${entry.topic ?? ''}`)
    lines.push(`tags: ${tagsFor(entry).join(', ')}`)
    lines.push(`aliases: ${aliasesFor(entry).join(', ')}`)
    lines.push(`confidence: ${entry.confidence.toFixed(3)}`)
    lines.push(`reinforcement: ${entry.reinforcement}`)
    lines.push(`first_seen: ${entry.firstSeenAt}`)
    lines.push(`last_seen: ${entry.lastSeenAt}`)
    if (entry.validFrom) lines.push(`valid_from: ${entry.validFrom}`)
    if (entry.validUntil) lines.push(`valid_until: ${entry.validUntil}`)
    lines.push(`source: ${entry.sources.map((s) => `${s.type}${s.ref ? `:${s.ref}` : ''}`).join(', ')}`)
    lines.push('')
    lines.push(entry.text)
    lines.push('')
  }
  return lines.join('\n')
}

function parseDocument(file: string, raw: string): ParsedDocEntry[] {
  const sections = raw.split(/\n(?=## )/g).filter((s) => s.startsWith('## '))
  const entries: ParsedDocEntry[] = []
  for (const section of sections) {
    const [headingLine = '', ...rest] = section.split('\n')
    const meta: Record<string, string> = {}
    let bodyStart = rest.length
    for (let i = 0; i < rest.length; i++) {
      const line = rest[i]!
      if (!line.trim()) {
        bodyStart = i + 1
        break
      }
      const m = line.match(/^([a-z_]+):\s*(.*)$/i)
      if (m) meta[m[1]!.toLowerCase()] = m[2]!.trim()
    }
    if (!meta.id) continue
    const kind = meta.kind === 'fuzzy' ? 'fuzzy' : 'longTerm'
    entries.push({
      id: meta.id,
      kind,
      file,
      title: headingLine.replace(/^##\s*/, '').trim(),
      topic: meta.topic || undefined,
      tags: splitList(meta.tags),
      aliases: splitList(meta.aliases),
      confidence: parseNumber(meta.confidence, kind === 'longTerm' ? 0.7 : 0.45),
      reinforcement: parseNumber(meta.reinforcement, 1),
      lastSeenAt: meta.last_seen || '',
      text: rest.slice(bodyStart).join('\n').trim(),
    })
  }
  return entries
}

function rebuildDocumentMemoryFts(dir: string, entries: ParsedDocEntry[]): void {
  const db = openDocumentMemoryDb(dir)
  try {
    ensureDocumentMemoryFts(db)
    const insert = db.prepare(`
      INSERT INTO memory_docs_fts
      (id, kind, file, title, topic, tags, aliases, body, confidence, reinforcement, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    db.transaction(() => {
      db.prepare('DELETE FROM memory_docs_fts').run()
      for (const entry of entries) {
        insert.run(
          entry.id,
          entry.kind,
          entry.file,
          entry.title,
          entry.topic ?? '',
          entry.tags.join(' '),
          entry.aliases.join(' '),
          entry.text,
          entry.confidence,
          entry.reinforcement,
          entry.lastSeenAt,
        )
      }
    })()
  } finally {
    db.close()
  }
}

function searchDocumentMemoryFts(dir: string, terms: string[], limit: number): DocumentMemoryHit[] {
  try {
    const db = openDocumentMemoryDb(dir)
    try {
      ensureDocumentMemoryFts(db)
      const query = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
      if (!query) return []
      const rows = db.prepare(`
        SELECT
          id,
          kind,
          file,
          title,
          topic,
          body,
          confidence,
          reinforcement,
          bm25(memory_docs_fts, 7.0, 6.0, 4.0, 4.0, 1.0) AS rank
        FROM memory_docs_fts
        WHERE memory_docs_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, Math.max(limit * 3, limit)) as Array<{
        id: string
        kind: 'longTerm' | 'fuzzy'
        file: string
        title: string
        topic: string
        body: string
        confidence: number
        reinforcement: number
        rank: number
      }>
      return rows
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          text: row.body.slice(0, 420),
          confidence: Number(row.confidence) || 0,
          reinforcement: Number(row.reinforcement) || 0,
          topic: row.topic || undefined,
          source: row.file,
          score: ftsScore(row.rank, Number(row.confidence) || 0, Number(row.reinforcement) || 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

function openDocumentMemoryDb(dir: string): Database.Database {
  const db = new Database(join(dir, 'index.db'))
  db.pragma('journal_mode = WAL')
  return db
}

function ensureDocumentMemoryFts(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_docs_fts USING fts5(
      id UNINDEXED,
      kind UNINDEXED,
      file UNINDEXED,
      title,
      topic,
      tags,
      aliases,
      body,
      confidence UNINDEXED,
      reinforcement UNINDEXED,
      last_seen_at UNINDEXED
    );
  `)
}

function ftsScore(rank: number, confidence: number, reinforcement: number): number {
  return (1 / (1 + Math.abs(rank))) * 10 + confidence * 3 + Math.log1p(reinforcement)
}

function rankEntries(entries: ParsedDocEntry[], terms: string[], expanded: boolean): DocumentMemoryHit[] {
  return entries
    .map((entry) => {
      const haystack = `${entry.title}\n${entry.topic ?? ''}\n${entry.tags.join(' ')}\n${entry.aliases.join(' ')}\n${entry.text}`.toLowerCase()
      let score = 0
      for (const term of terms) {
        const t = term.toLowerCase()
        if (!t) continue
        if (entry.title.toLowerCase().includes(t)) score += expanded ? 4 : 8
        if (entry.topic?.toLowerCase().includes(t)) score += expanded ? 4 : 7
        if (entry.tags.some((tag) => tag.toLowerCase().includes(t))) score += expanded ? 3 : 6
        if (entry.aliases.some((alias) => alias.toLowerCase().includes(t))) score += expanded ? 3 : 6
        if (haystack.includes(t)) score += expanded ? 1 : 2
      }
      score += entry.confidence * 3 + Math.log1p(entry.reinforcement)
      return score > 0 ? toHit(entry, score) : null
    })
    .filter((hit): hit is DocumentMemoryHit => Boolean(hit))
    .sort((a, b) => b.score - a.score)
}

function expandTerms(terms: string[], entries: ParsedDocEntry[]): string[] {
  const out = new Set(terms)
  const termText = terms.join(' ').toLowerCase()
  for (const entry of entries) {
    const candidates = [entry.topic, ...entry.tags, ...entry.aliases].filter((v): v is string => Boolean(v))
    if (candidates.some((c) => fuzzyOverlap(termText, c.toLowerCase()))) {
      for (const c of candidates) out.add(c)
    }
  }
  return [...out].slice(0, 16)
}

function extractSearchTerms(input: string): string[] {
  const out: string[] = []
  for (const m of input.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}|[\p{Script=Han}]{2,8}/gu)) {
    const token = m[0].trim()
    if (token && !STOP_WORDS.has(token.toLowerCase())) out.push(token)
  }
  return [...new Set(out)].slice(0, 12)
}

function toIndexEntry(file: string, kind: 'longTerm' | 'fuzzy', entry: SubconsciousMemoryEntry): DocumentMemoryIndex['entries'][number] {
  return {
    id: entry.id,
    kind,
    file,
    title: entry.text.slice(0, 48),
    topic: entry.topic,
    tags: tagsFor(entry),
    aliases: aliasesFor(entry),
    confidence: entry.confidence,
    reinforcement: entry.reinforcement,
    lastSeenAt: entry.lastSeenAt,
  }
}

function toHit(entry: ParsedDocEntry, score: number): DocumentMemoryHit {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    text: entry.text.slice(0, 420),
    confidence: entry.confidence,
    reinforcement: entry.reinforcement,
    topic: entry.topic,
    source: entry.file,
    score,
  }
}

function tagsFor(entry: SubconsciousMemoryEntry): string[] {
  return unique([entry.topic, ...entry.sources.map((s) => s.type), ...extractSearchTerms(entry.text).slice(0, 5)])
}

function aliasesFor(entry: SubconsciousMemoryEntry): string[] {
  return unique([entry.topic, ...extractSearchTerms(entry.text).slice(0, 4)])
}

function splitList(input: string | undefined): string[] {
  return input?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
}

function parseNumber(input: string | undefined, fallback: number): number {
  const n = Number(input)
  return Number.isFinite(n) ? n : fallback
}

function unique(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((v): v is string => Boolean(v?.trim())).map((v) => v.trim()))]
}

function fuzzyOverlap(a: string, b: string): boolean {
  if (a.includes(b) || b.includes(a)) return true
  const aa = new Set(a.split(/\s+/).filter(Boolean))
  const bb = new Set(b.split(/\s+/).filter(Boolean))
  if (aa.size === 0 || bb.size === 0) return false
  const overlap = [...aa].filter((x) => bb.has(x)).length
  return overlap / Math.min(aa.size, bb.size) >= 0.5
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  '怎么',
  '这个',
  '那个',
  '现在',
  '实现',
  '功能',
  '需要',
  '什么',
])
