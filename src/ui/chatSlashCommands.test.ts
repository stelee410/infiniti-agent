import { describe, expect, it } from 'vitest'
import { CHAT_HELP_TEXT, parseChatSlashCommand } from './chatSlashCommands.js'

describe('parseChatSlashCommand', () => {
  it('parses exact command aliases', () => {
    expect(parseChatSlashCommand('/quit')).toEqual({ kind: 'exit' })
    expect(parseChatSlashCommand('/new')).toEqual({ kind: 'clear' })
    expect(parseChatSlashCommand('/reload-skills')).toEqual({ kind: 'reload' })
    expect(parseChatSlashCommand('/help')).toEqual({ kind: 'help' })
  })

  it('parses schedule commands and ids', () => {
    expect(parseChatSlashCommand('/schedule')).toEqual({ kind: 'scheduleList' })
    expect(parseChatSlashCommand('/schedule list')).toEqual({ kind: 'scheduleList' })
    expect(parseChatSlashCommand('/schedule clear')).toEqual({ kind: 'scheduleClear' })
    expect(parseChatSlashCommand('/schedule rm sch_123')).toEqual({
      kind: 'scheduleRemove',
      id: 'sch_123',
    })
    const add = parseChatSlashCommand('/schedule add 每分钟检查消息')
    expect(add?.kind).toBe('scheduleAdd')
    expect(add && add.kind === 'scheduleAdd' ? add.parsed?.kind : undefined).toBe('interval')
  })

  it('parses inbox, compact, and roll argument variants', () => {
    expect(parseChatSlashCommand('/inbox')).toEqual({ kind: 'inbox', unreadOnly: true })
    expect(parseChatSlashCommand('/inbox --all')).toEqual({ kind: 'inbox', unreadOnly: false })
    expect(parseChatSlashCommand('/compact 只保留重点')).toEqual({
      kind: 'compact',
      instructions: '只保留重点',
    })
    expect(parseChatSlashCommand('/roll')).toEqual({ kind: 'roll', layers: 1 })
    expect(parseChatSlashCommand('/roll 2')).toEqual({ kind: 'roll', layers: 2 })
    expect(parseChatSlashCommand('/roll nope')).toEqual({ kind: 'roll', layers: null })
  })

  it('parses dream commands', () => {
    expect(parseChatSlashCommand('/dream')).toEqual({ kind: 'dreamDiary' })
    expect(parseChatSlashCommand('/dream diary')).toEqual({ kind: 'dreamDiary' })
    expect(parseChatSlashCommand('/dream context')).toEqual({ kind: 'dreamContext' })
    expect(parseChatSlashCommand('/dream run')).toEqual({ kind: 'dreamRun', mode: 'full' })
    expect(parseChatSlashCommand('/dream run light')).toEqual({ kind: 'dreamRun', mode: 'light' })
  })

  it('ignores non-registered commands', () => {
    expect(parseChatSlashCommand('/snap image')).toBeNull()
    expect(parseChatSlashCommand('hello')).toBeNull()
  })

  it('keeps help text centralized', () => {
    expect(CHAT_HELP_TEXT).toContain('/schedule')
    expect(CHAT_HELP_TEXT).toContain('/dream')
    expect(CHAT_HELP_TEXT).toContain('/avatargen')
  })
})
