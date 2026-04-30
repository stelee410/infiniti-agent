import { describe, expect, it } from 'vitest'
import { looksLikeScheduleRequest, parseScheduleRequest } from './parser.js'

describe('parseScheduleRequest', () => {
  const now = new Date('2026-04-29T10:00:00+08:00')

  it('parses daily Chinese time schedules', () => {
    const parsed = parseScheduleRequest('每天早上8点给我播放最新的Hacknews摘要', now)
    expect(parsed?.kind).toBe('daily')
    expect(parsed?.timeOfDay).toBe('08:00')
    expect(parsed?.prompt).toContain('Hacknews')
    expect(parsed?.nextRunAt.getTime()).toBeGreaterThan(now.getTime())
  })

  it('parses interval schedules', () => {
    const parsed = parseScheduleRequest('每分钟检查一次邮箱', now)
    expect(parsed?.kind).toBe('interval')
    expect(parsed?.intervalMs).toBe(60000)
    expect(parsed?.prompt).toBe('检查一次邮箱')
  })

  it('parses conversational one-off reminders', () => {
    expect(looksLikeScheduleRequest('帮我明天九点提醒我开会')).toBe(true)
    const parsed = parseScheduleRequest('帮我明天九点提醒我开会', now)
    expect(parsed?.kind).toBe('once')
    expect(parsed?.prompt).toBe('开会')
    expect(parsed?.nextRunAt.toISOString()).toBe('2026-04-30T01:00:00.000Z')
  })

  it('parses relative reminders', () => {
    expect(looksLikeScheduleRequest('10分钟后提醒我喝水')).toBe(true)
    const parsed = parseScheduleRequest('10分钟后提醒我喝水', now)
    expect(parsed?.kind).toBe('once')
    expect(parsed?.prompt).toBe('喝水')
    expect(parsed?.nextRunAt.toISOString()).toBe('2026-04-29T02:10:00.000Z')
  })

  it('parses evening half-hour reminders', () => {
    expect(looksLikeScheduleRequest('今晚八点半叫我看邮件')).toBe(true)
    const parsed = parseScheduleRequest('今晚八点半叫我看邮件', now)
    expect(parsed?.kind).toBe('once')
    expect(parsed?.prompt).toBe('看邮件')
    expect(parsed?.nextRunAt.toISOString()).toBe('2026-04-29T12:30:00.000Z')
  })

  it('parses near-future broadcast requests without reminder words', () => {
    const lateNow = new Date('2026-04-29T22:50:00+08:00')
    expect(looksLikeScheduleRequest('一会儿10点55，给我播报Hacknews最新文章哈')).toBe(true)
    const parsed = parseScheduleRequest('一会儿10点55，给我播报Hacknews最新文章哈', lateNow)
    expect(parsed?.kind).toBe('once')
    expect(parsed?.prompt).toBe('播报Hacknews最新文章哈')
    expect(parsed?.nextRunAt.toISOString()).toBe('2026-04-29T14:55:00.000Z')
  })

  it('parses exact-hour near-future reminders', () => {
    const lateNow = new Date('2026-04-29T22:50:00+08:00')
    expect(looksLikeScheduleRequest('一会儿23点整提醒我好好休息')).toBe(true)
    const parsed = parseScheduleRequest('一会儿23点整提醒我好好休息', lateNow)
    expect(parsed?.kind).toBe('once')
    expect(parsed?.prompt).toBe('好好休息')
    expect(parsed?.nextRunAt.toISOString()).toBe('2026-04-29T15:00:00.000Z')
  })
})
