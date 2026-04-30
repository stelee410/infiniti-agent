import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { localSchedulesPath } from '../paths.js'

export type ScheduleKind = 'once' | 'interval' | 'daily'

export type ScheduleTask = {
  version: 1
  id: string
  enabled: boolean
  kind: ScheduleKind
  prompt: string
  createdAt: string
  nextRunAt: string
  lastRunAt?: string
  lastResultAt?: string
  lastError?: string
  intervalMs?: number
  timeOfDay?: string
  timezone?: string
  runCount: number
}

export type ScheduleStore = {
  version: 1
  tasks: ScheduleTask[]
}

export type ScheduleCreateInput = {
  kind: ScheduleKind
  prompt: string
  nextRunAt: Date
  intervalMs?: number
  timeOfDay?: string
  timezone?: string
}

function defaultStore(): ScheduleStore {
  return { version: 1, tasks: [] }
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 96)
}

function newId(now = new Date()): string {
  return sanitizeId(`sch_${now.toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 8)}`)
}

export async function loadScheduleStore(cwd: string): Promise<ScheduleStore> {
  try {
    const parsed = JSON.parse(await readFile(localSchedulesPath(cwd), 'utf8')) as ScheduleStore
    if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) return defaultStore()
    return {
      version: 1,
      tasks: parsed.tasks.filter((t) => t?.version === 1 && typeof t.id === 'string' && typeof t.prompt === 'string'),
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return defaultStore()
    throw e
  }
}

export async function saveScheduleStore(cwd: string, store: ScheduleStore): Promise<void> {
  const p = localSchedulesPath(cwd)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

export async function addScheduleTask(cwd: string, input: ScheduleCreateInput): Promise<ScheduleTask> {
  const store = await loadScheduleStore(cwd)
  const now = new Date()
  const task: ScheduleTask = {
    version: 1,
    id: newId(now),
    enabled: true,
    kind: input.kind,
    prompt: input.prompt.trim(),
    createdAt: now.toISOString(),
    nextRunAt: input.nextRunAt.toISOString(),
    runCount: 0,
    ...(input.intervalMs ? { intervalMs: input.intervalMs } : {}),
    ...(input.timeOfDay ? { timeOfDay: input.timeOfDay } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
  }
  store.tasks.push(task)
  await saveScheduleStore(cwd, store)
  return task
}

export async function removeScheduleTask(cwd: string, idPrefix: string): Promise<ScheduleTask | null> {
  const store = await loadScheduleStore(cwd)
  const idx = store.tasks.findIndex((t) => t.id === idPrefix || t.id.startsWith(idPrefix))
  if (idx < 0) return null
  const [removed] = store.tasks.splice(idx, 1)
  await saveScheduleStore(cwd, store)
  return removed ?? null
}

export async function clearCompletedScheduleTasks(cwd: string): Promise<{ removed: ScheduleTask[]; remaining: number }> {
  const store = await loadScheduleStore(cwd)
  const removed = store.tasks.filter((t) => !t.enabled)
  if (!removed.length) return { removed: [], remaining: store.tasks.length }
  store.tasks = store.tasks.filter((t) => t.enabled)
  await saveScheduleStore(cwd, store)
  return { removed, remaining: store.tasks.length }
}

export function dueScheduleTasks(store: ScheduleStore, now = new Date()): ScheduleTask[] {
  const t = now.getTime()
  return store.tasks
    .filter((task) => task.enabled && Date.parse(task.nextRunAt) <= t)
    .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
}

export function advanceScheduleTask(task: ScheduleTask, now = new Date()): ScheduleTask {
  const next: ScheduleTask = {
    ...task,
    lastRunAt: now.toISOString(),
    lastResultAt: now.toISOString(),
    lastError: undefined,
    runCount: task.runCount + 1,
  }
  if (task.kind === 'once') {
    next.enabled = false
    return next
  }
  if (task.kind === 'interval') {
    const intervalMs = Math.max(1000, task.intervalMs ?? 60000)
    next.nextRunAt = new Date(now.getTime() + intervalMs).toISOString()
    return next
  }
  if (task.kind === 'daily') {
    next.nextRunAt = nextDailyRun(task.timeOfDay ?? '08:00', now).toISOString()
    return next
  }
  return next
}

export function failScheduleTask(task: ScheduleTask, error: string, now = new Date()): ScheduleTask {
  return {
    ...advanceScheduleTask(task, now),
    lastError: error.slice(0, 1000),
  }
}

export function nextDailyRun(timeOfDay: string, now = new Date()): Date {
  const m = timeOfDay.match(/^(\d{1,2}):(\d{2})$/)
  const hh = m ? Math.max(0, Math.min(23, Number(m[1]))) : 8
  const mm = m ? Math.max(0, Math.min(59, Number(m[2]))) : 0
  const d = new Date(now)
  d.setHours(hh, mm, 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d
}

function userTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  } catch {
    return 'local'
  }
}

function formatLocalDateTime(iso: string, timeZone: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timeZone === 'local' ? undefined : timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d)
  } catch {
    return d.toLocaleString('zh-CN', { hour12: false })
  }
}

export function formatScheduleTask(task: ScheduleTask, opts: { timeZone?: string } = {}): string {
  const status = task.enabled ? 'on' : 'off'
  const timeZone = opts.timeZone ?? task.timezone ?? userTimeZone()
  const cadence =
    task.kind === 'daily'
      ? `每天 ${task.timeOfDay ?? '08:00'}`
      : task.kind === 'interval'
        ? `每 ${formatInterval(task.intervalMs ?? 60000)}`
        : '一次'
  const next = formatLocalDateTime(task.nextRunAt, timeZone)
  return `${task.id.slice(0, 18)} [${status}] ${cadence} next=${next} (${timeZone}) :: ${task.prompt}`
}

function formatInterval(ms: number): string {
  if (ms % 3600000 === 0) return `${ms / 3600000}小时`
  if (ms % 60000 === 0) return `${ms / 60000}分钟`
  if (ms % 1000 === 0) return `${ms / 1000}秒`
  return `${ms}ms`
}
