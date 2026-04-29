import { nextDailyRun, type ScheduleCreateInput } from './store.js'

function taskText(raw: string, prefixEnd: number): string {
  return raw.slice(prefixEnd).replace(/^(给我|帮我|去|执行|做|播放|检查)?/, (m) => m).trim()
}

export function parseScheduleRequest(rawInput: string, now = new Date()): ScheduleCreateInput | null {
  const raw = rawInput.trim()
  if (!raw) return null
  const text = raw.replace(/^\/schedule\s+(add\s+)?/i, '').trim()

  const everyMinute = text.match(/^每\s*(\d+)?\s*分钟(?:一次)?(.+)$/)
  if (everyMinute) {
    const n = Math.max(1, Number(everyMinute[1] || 1))
    return { kind: 'interval', intervalMs: n * 60000, nextRunAt: now, prompt: taskText(everyMinute[2] ?? '', 0) }
  }

  const everyHour = text.match(/^每\s*(\d+)?\s*小时(?:一次)?(.+)$/)
  if (everyHour) {
    const n = Math.max(1, Number(everyHour[1] || 1))
    return { kind: 'interval', intervalMs: n * 3600000, nextRunAt: now, prompt: taskText(everyHour[2] ?? '', 0) }
  }

  const interval = text.match(/^每\s*(\d+)\s*(秒|分钟|小时|天)(?:一次)?(.+)$/)
  if (interval) {
    const n = Math.max(1, Number(interval[1]))
    const unit = interval[2]
    const ms = unit === '秒' ? n * 1000 : unit === '分钟' ? n * 60000 : unit === '小时' ? n * 3600000 : n * 86400000
    return { kind: 'interval', intervalMs: ms, nextRunAt: now, prompt: taskText(interval[3] ?? '', 0) }
  }

  const daily = text.match(/^每天(?:早上|上午|中午|下午|晚上|夜里)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)?(?:分)?\s*(.+)$/)
  if (daily) {
    let hour = Number(daily[1])
    const minute = Math.max(0, Math.min(59, Number(daily[2] || 0)))
    if (/下午|晚上|夜里/.test(text) && hour < 12) hour += 12
    if (/中午/.test(text) && hour < 11) hour += 12
    hour = Math.max(0, Math.min(23, hour))
    const timeOfDay = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    return { kind: 'daily', timeOfDay, nextRunAt: nextDailyRun(timeOfDay, now), prompt: taskText(daily[3] ?? '', 0) }
  }

  const once = text.match(/^(?:在|今天|明天)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)?(?:分)?\s*(.+)$/)
  if (/^(定时|计划|提醒|schedule)/i.test(raw) && once) {
    const d = new Date(now)
    if (text.startsWith('明天')) d.setDate(d.getDate() + 1)
    d.setHours(Math.max(0, Math.min(23, Number(once[1]))), Math.max(0, Math.min(59, Number(once[2] || 0))), 0, 0)
    if (!text.startsWith('明天') && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
    return { kind: 'once', nextRunAt: d, prompt: taskText(once[3] ?? '', 0) }
  }

  return null
}

export function looksLikeScheduleRequest(rawInput: string): boolean {
  const s = rawInput.trim()
  return /^(\/schedule\s+add|定时|计划|提醒|每天|每\s*\d*\s*(秒|分钟|小时|天))/i.test(s)
}
