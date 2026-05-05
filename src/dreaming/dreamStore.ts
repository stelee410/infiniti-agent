import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { localDreamsDir } from '../paths.js'
import type { DreamDiary, DreamEpisode, DreamMemoryCandidate, DreamPromptContext, DreamRun, DreamSource, DreamMode, LucidDreamIdea } from './types.js'

const RUNS_FILE = 'dream-runs.jsonl'
const EPISODES_FILE = 'episodes.jsonl'
const CANDIDATES_FILE = 'candidates.jsonl'
const IDEAS_FILE = 'dream-ideas.jsonl'
const CONTEXT_FILE = 'prompt-context.json'
const CONTEXT_MAX_LIST_ITEMS = 6
const CONTEXT_MAX_FIELD_CHARS = 320

export function dreamsDir(cwd: string): string {
  return localDreamsDir(cwd)
}

export function dreamDiariesDir(cwd: string): string {
  return join(dreamsDir(cwd), 'diaries')
}

export async function startDreamRun(
  cwd: string,
  input: { mode: DreamMode; source: DreamSource; reason: string; now?: Date },
): Promise<DreamRun> {
  const now = input.now ?? new Date()
  const run: DreamRun = {
    id: newId('dream', now),
    version: 1,
    mode: input.mode,
    source: input.source,
    startedAt: now.toISOString(),
    status: 'running',
    reason: input.reason,
  }
  await appendJsonl(join(dreamsDir(cwd), RUNS_FILE), run)
  return run
}

export async function finishDreamRun(
  cwd: string,
  run: DreamRun,
  patch: Partial<DreamRun> & { status: DreamRun['status'] },
  now = new Date(),
): Promise<DreamRun> {
  const next: DreamRun = {
    ...run,
    ...patch,
    completedAt: patch.completedAt ?? now.toISOString(),
  }
  await appendJsonl(join(dreamsDir(cwd), RUNS_FILE), next)
  return next
}

export async function appendDreamEpisode(cwd: string, episode: DreamEpisode): Promise<void> {
  await appendJsonl(join(dreamsDir(cwd), EPISODES_FILE), episode)
}

export async function appendDreamMemoryCandidates(
  cwd: string,
  candidates: DreamMemoryCandidate[],
  meta: { runId: string; episodeId: string; createdAt?: string },
): Promise<void> {
  const createdAt = meta.createdAt ?? new Date().toISOString()
  for (const candidate of candidates) {
    await appendJsonl(join(dreamsDir(cwd), CANDIDATES_FILE), {
      ...candidate,
      dreamRunId: meta.runId,
      episodeId: meta.episodeId,
      createdAt,
    })
  }
}

export async function appendDreamIdeas(
  cwd: string,
  ideas: LucidDreamIdea[],
  meta: { runId: string; episodeId: string; createdAt?: string },
): Promise<void> {
  const createdAt = meta.createdAt ?? new Date().toISOString()
  for (const idea of ideas) {
    await appendJsonl(join(dreamsDir(cwd), IDEAS_FILE), {
      ...idea,
      dreamRunId: meta.runId,
      episodeId: meta.episodeId,
      createdAt,
    })
  }
}

export async function saveDreamPromptContext(cwd: string, context: DreamPromptContext): Promise<void> {
  const p = join(dreamsDir(cwd), CONTEXT_FILE)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(normalizeDreamPromptContext(context), null, 2) + '\n', 'utf8')
}

export async function loadDreamPromptContext(cwd: string): Promise<DreamPromptContext | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dreamsDir(cwd), CONTEXT_FILE), 'utf8')) as DreamPromptContext
    if (parsed && typeof parsed.updatedAt === 'string') return normalizeDreamPromptContext(parsed)
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') throw e
  }
  return null
}

export function normalizeDreamPromptContext(context: DreamPromptContext): DreamPromptContext {
  return {
    updatedAt: cleanText(context.updatedAt, 80) || new Date().toISOString(),
    ...(cleanText(context.longHorizonObjective, CONTEXT_MAX_FIELD_CHARS)
      ? { longHorizonObjective: cleanText(context.longHorizonObjective, CONTEXT_MAX_FIELD_CHARS) }
      : {}),
    ...(cleanText(context.recentInsight, CONTEXT_MAX_FIELD_CHARS)
      ? { recentInsight: cleanText(context.recentInsight, CONTEXT_MAX_FIELD_CHARS) }
      : {}),
    relevantStableMemories: cleanList(context.relevantStableMemories),
    behaviorGuidance: cleanList(context.behaviorGuidance),
    unresolvedThreads: cleanList(context.unresolvedThreads),
    ...(cleanText(context.creativeHint, CONTEXT_MAX_FIELD_CHARS)
      ? { creativeHint: cleanText(context.creativeHint, CONTEXT_MAX_FIELD_CHARS) }
      : {}),
    cautions: cleanList(context.cautions),
  }
}

export async function saveDreamDiary(cwd: string, diary: DreamDiary): Promise<void> {
  const dir = dreamDiariesDir(cwd)
  await mkdir(dir, { recursive: true })
  const safe = sanitizeFilePart(diary.createdAt)
  await writeFile(join(dir, `${safe}.json`), JSON.stringify(diary, null, 2) + '\n', 'utf8')
  await writeFile(join(dir, `${safe}.md`), renderDreamDiaryMarkdown(diary), 'utf8')
}

export async function loadRecentDreamDiaries(cwd: string, limit = 3): Promise<DreamDiary[]> {
  const dir = dreamDiariesDir(cwd)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return []
    throw e
  }
  const out: DreamDiary[] = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort().reverse()) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as DreamDiary
      if (parsed?.id && parsed.createdAt) out.push(parsed)
      if (out.length >= limit) break
    } catch {
      // Ignore malformed local dream diaries.
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function loadLatestDreamDiary(cwd: string): Promise<DreamDiary | null> {
  const diaries = await loadRecentDreamDiaries(cwd, 1)
  return diaries[0] ?? null
}

export function renderDreamDiaryMarkdown(diary: DreamDiary): string {
  const lines = [
    `# ${diary.title || '我的梦境笔记'}`,
    '',
    `- id: ${diary.id}`,
    `- created_at: ${diary.createdAt}`,
    `- visible_to_user: ${diary.visibleToUser ? 'true' : 'false'}`,
    '',
    diary.summary,
    '',
    '## What Happened',
    ...listLines(diary.whatHappened),
    '',
    '## What I Understood',
    ...listLines(diary.whatIUnderstood),
    '',
    '## Memory Changes',
    ...listLines(diary.memoriesChanged),
    '',
    '## Meta State Changes',
    ...listLines(diary.metaStateChanges),
  ]
  if (diary.currentObjective) {
    lines.push('', '## Current Objective', '', diary.currentObjective)
  }
  if (diary.creativeInsights.length) {
    lines.push('', '## Creative Insights', ...listLines(diary.creativeInsights))
  }
  if (diary.messageToUser) {
    lines.push('', '## Message To User', '', diary.messageToUser)
  }
  lines.push('')
  return lines.join('\n')
}

function listLines(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ['- none']
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => cleanText(item, CONTEXT_MAX_FIELD_CHARS))
    .filter(Boolean)
    .slice(0, CONTEXT_MAX_LIST_ITEMS)
}

function cleanText(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxChars) : ''
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const line = JSON.stringify(value)
  const existing = await readExisting(path)
  await writeFile(path, existing + line + '\n', 'utf8')
}

async function readExisting(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return ''
    throw e
  }
}

function newId(prefix: string, now: Date): string {
  return `${prefix}_${sanitizeFilePart(now.toISOString())}_${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeFilePart(input: string): string {
  return basename(input.replace(/[:.]/g, '-').replace(/[^a-zA-Z0-9_-]/g, '-')).slice(0, 120)
}
