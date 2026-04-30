import { nextDailyRun, type ScheduleCreateInput } from './store.js'

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

const NUM = String.raw`(?:\d{1,3}|[零〇一二两三四五六七八九十]{1,4}|半)`
const TIME_NUM = String.raw`(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,4})`
const DAY_HINT = String.raw`(?:一会儿|一会|待会儿|待会|等会儿|等会|稍后|今天|明天|今晚|今早|明早|明晚|早上|上午|中午|下午|晚上|夜里|凌晨)`

function parseChineseNumber(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '半') return 0.5
  if (Object.prototype.hasOwnProperty.call(CN_DIGITS, s)) return CN_DIGITS[s]!
  if (s === '十') return 10
  const ten = s.match(/^([零〇一二两三四五六七八九])?十([零〇一二两三四五六七八九])?$/)
  if (ten) return (ten[1] ? CN_DIGITS[ten[1]]! : 1) * 10 + (ten[2] ? CN_DIGITS[ten[2]]! : 0)
  return null
}

function parseNumber(raw: string): number {
  return parseChineseNumber(raw) ?? Number(raw)
}

function taskText(raw: string): string {
  return raw
    .replace(/^[\s,，。:：；;]+/, '')
    .replace(/^整\s*/, '')
    .replace(/^(?:请|麻烦|帮我|给我|替我|帮忙|到时候|记得|再)?\s*/, '')
    .replace(/^(?:提醒我|提醒一下我|提醒一下|提醒|叫我|通知我|跟我说|告诉我)\s*/, '')
    .replace(/^[\s,，。:：；;]+/, '')
    .trim()
}

function onceAt(dayText: string, hourText: string, minuteText: string | undefined, suffix: string, now: Date): ScheduleCreateInput | null {
  let hour = parseNumber(hourText)
  if (!Number.isFinite(hour)) return null
  const halfMinute = suffix.includes('半') ? 30 : undefined
  const minute = Math.max(0, Math.min(59, minuteText ? parseNumber(minuteText) : halfMinute ?? 0))
  if (!Number.isFinite(minute)) return null
  const nearFuture = /一会儿|一会|待会儿|待会|等会儿|等会|稍后/.test(dayText)
  if (/下午|晚上|今晚|夜里|夜间/.test(dayText) && hour < 12) hour += 12
  if (/中午/.test(dayText) && hour < 11) hour += 12
  if (/凌晨/.test(dayText) && hour === 12) hour = 0
  hour = Math.max(0, Math.min(23, hour))

  const d = new Date(now)
  if (/明天|明早|明晚/.test(dayText)) d.setDate(d.getDate() + 1)
  d.setHours(hour, minute, 0, 0)
  if (nearFuture && d.getTime() <= now.getTime() && hour < 12) {
    d.setHours(hour + 12, minute, 0, 0)
  }
  if (!/明天|明早|明晚|今天|今晚|今早/.test(dayText) && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  if (/今天|今晚|今早/.test(dayText) && d.getTime() <= now.getTime()) return null
  const prompt = taskText(suffix.replace(/^半/, ''))
  return prompt ? { kind: 'once', nextRunAt: d, prompt } : null
}

export function parseScheduleRequest(rawInput: string, now = new Date()): ScheduleCreateInput | null {
  const raw = rawInput.trim()
  if (!raw) return null
  const text = raw
    .replace(/^\/schedule\s+(add\s+)?/i, '')
    .replace(/^(?:请|麻烦|帮我|给我|替我|帮忙)\s*/, '')
    .trim()

  const everyMinute = text.match(/^每\s*(\d+)?\s*分钟(?:一次)?(.+)$/)
  if (everyMinute) {
    const n = Math.max(1, Number(everyMinute[1] || 1))
    return { kind: 'interval', intervalMs: n * 60000, nextRunAt: now, prompt: taskText(everyMinute[2] ?? '') }
  }

  const everyHour = text.match(/^每\s*(\d+)?\s*小时(?:一次)?(.+)$/)
  if (everyHour) {
    const n = Math.max(1, Number(everyHour[1] || 1))
    return { kind: 'interval', intervalMs: n * 3600000, nextRunAt: now, prompt: taskText(everyHour[2] ?? '') }
  }

  const interval = text.match(new RegExp(`^每\\s*(${NUM})\\s*(秒|分钟|分|小时|钟头|天|日)(?:一次)?(.+)$`))
  if (interval) {
    const n = Math.max(1, parseNumber(interval[1] ?? '1'))
    const unit = interval[2]
    const ms = unit === '秒' ? n * 1000 : unit === '分钟' || unit === '分' ? n * 60000 : unit === '小时' || unit === '钟头' ? n * 3600000 : n * 86400000
    return { kind: 'interval', intervalMs: ms, nextRunAt: now, prompt: taskText(interval[3] ?? '') }
  }

  const relative = text.match(new RegExp(`^(?:在|等|过)?\\s*(${NUM})\\s*(秒|分钟|分|小时|钟头|天|日)(?:之后|以后|后)\\s*(.+)$`))
  if (relative) {
    const n = parseNumber(relative[1] ?? '')
    if (!Number.isFinite(n) || n <= 0) return null
    const unit = relative[2]
    const ms = unit === '秒' ? n * 1000 : unit === '分钟' || unit === '分' ? n * 60000 : unit === '小时' || unit === '钟头' ? n * 3600000 : n * 86400000
    const prompt = taskText(relative[3] ?? '')
    return prompt ? { kind: 'once', nextRunAt: new Date(now.getTime() + ms), prompt } : null
  }

  const daily = text.match(new RegExp(`^(?:每天|每日|天天)(早上|上午|中午|下午|晚上|夜里|凌晨)?\\s*(${TIME_NUM})(?:[:：点时]\\s*(${TIME_NUM})?)?(?:分)?(半|整)?\\s*(.+)$`))
  if (daily) {
    let hour = parseNumber(daily[2] ?? '')
    const minute = Math.max(0, Math.min(59, daily[3] ? parseNumber(daily[3]) : daily[4] ? 30 : 0))
    if (/下午|晚上|夜里/.test(text) && hour < 12) hour += 12
    if (/中午/.test(text) && hour < 11) hour += 12
    if (/凌晨/.test(text) && hour === 12) hour = 0
    hour = Math.max(0, Math.min(23, hour))
    const timeOfDay = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    return { kind: 'daily', timeOfDay, nextRunAt: nextDailyRun(timeOfDay, now), prompt: taskText(daily[5] ?? '') }
  }

  const once = text.match(new RegExp(`^(?:(${DAY_HINT})\\s*)?(?:在)?\\s*(${TIME_NUM})(?:[:：点时]\\s*(${TIME_NUM})?)?(?:分)?(半|整)?\\s*(.+)$`))
  if (once && (looksLikeScheduleRequest(raw) || new RegExp(DAY_HINT).test(text))) {
    return onceAt(once[1] ?? '', once[2] ?? '', once[3], `${once[4] ?? ''}${once[5] ?? ''}`, now)
  }

  return null
}

export function looksLikeScheduleRequest(rawInput: string): boolean {
  const s = rawInput.trim()
  if (/^(\/schedule\s+add|定时|计划|提醒|每天|每日|天天|每\s*(?:\d+|[零〇一二两三四五六七八九十半]*)\s*(秒|分钟|分|小时|钟头|天|日))/i.test(s)) return true
  const intent = String.raw`(?:提醒我|提醒一下|提醒|叫我|通知我|告诉我|跟我说|记得|播报|播放|检查|执行)`
  const clock = String.raw`(?:${DAY_HINT}\s*)?(?:在)?\s*${TIME_NUM}\s*(?::|：|点|时)\s*${TIME_NUM}?(?:分)?(?:半|整)?`
  const time = String.raw`(?:${DAY_HINT}|${clock}|\d+\s*(?:秒|分钟|分|小时|天)(?:后|之后|以后)|[零〇一二两三四五六七八九十半]+\s*(?:秒|分钟|分|小时|天)(?:后|之后|以后))`
  return new RegExp(`${intent}.*${time}|${time}.*${intent}`, 'i').test(s)
}
