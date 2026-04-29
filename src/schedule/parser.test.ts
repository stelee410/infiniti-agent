import { describe, expect, it } from 'vitest'
import { parseScheduleRequest } from './parser.js'

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
})
