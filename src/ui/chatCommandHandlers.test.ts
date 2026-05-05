import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { InfinitiConfig } from '../config/types.js'
import { loadScheduleStore } from '../schedule/store.js'
import { loadSession, saveSession } from '../session/file.js'
import { searchSessions } from '../session/archive.js'
import { EditHistory } from '../session/editHistory.js'
import { writeInboxMessage } from '../inbox/store.js'
import { saveDreamDiary, saveDreamPromptContext } from '../dreaming/dreamStore.js'
import {
  handleClearSlashCommand,
  handleCompactSlashCommand,
  handleConfigSlashCommand,
  handleDebugSlashCommand,
  handleDreamSlashCommand,
  handleExitSlashCommand,
  handleHelpSlashCommand,
  handleInboxSlashCommand,
  handleMemorySlashCommand,
  handlePermissionSlashCommand,
  handleReloadSlashCommand,
  handleRollSlashCommand,
  handleScheduleSlashCommand,
  handleSpeakSlashCommand,
  handleUndoSlashCommand,
} from './chatCommandHandlers.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-chat-handler-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function ui() {
  return {
    setError: vi.fn(),
    setInput: vi.fn(),
    setNotice: vi.fn(),
    clearNoticeLater: vi.fn(),
    deliverLocalCommandExchange: vi.fn(),
  }
}

function makeConfig(compaction?: InfinitiConfig['compaction']): InfinitiConfig {
  return {
    version: 1,
    llm: {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-test',
    },
    compaction,
  }
}

describe('handleScheduleSlashCommand', () => {
  it('creates and lists schedule tasks', async () => {
    const u = ui()
    await handleScheduleSlashCommand(
      cwd,
      '/schedule add 每分钟检查消息',
      { kind: 'scheduleAdd', parsed: { kind: 'interval', prompt: '检查消息', nextRunAt: new Date(), intervalMs: 60000 } },
      u,
    )

    const store = await loadScheduleStore(cwd)
    expect(store.tasks).toHaveLength(1)
    expect(u.deliverLocalCommandExchange).toHaveBeenCalledWith(
      '/schedule add 每分钟检查消息',
      expect.stringContaining('已创建计划任务'),
    )

    await handleScheduleSlashCommand(cwd, '/schedule', { kind: 'scheduleList' }, u)
    expect(u.deliverLocalCommandExchange).toHaveBeenLastCalledWith(
      '/schedule',
      expect.stringContaining('当前计划任务'),
    )
  })

  it('rejects empty remove ids without touching the store', async () => {
    const u = ui()
    await handleScheduleSlashCommand(cwd, '/schedule remove ', { kind: 'scheduleRemove', id: '' }, u)
    expect(u.setError).toHaveBeenCalledWith(expect.stringContaining('请提供计划任务 id'))
  })
})

describe('handleInboxSlashCommand', () => {
  it('shows inbox summaries and opens the latest email in LiveUI', async () => {
    const u = ui()
    await writeInboxMessage(cwd, { id: 'msg-a', subject: '第一封', body: 'body' })

    await handleInboxSlashCommand(cwd, { kind: 'inbox', unreadOnly: true }, null, u)
    expect(u.setNotice).toHaveBeenCalledWith(expect.stringContaining('第一封'))
    expect(u.clearNoticeLater).toHaveBeenCalledWith(15000)

    const liveUi = { openInbox: vi.fn() }
    await handleInboxSlashCommand(cwd, { kind: 'lastEmail' }, liveUi, u)
    expect(liveUi.openInbox).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'msg-a', subject: '第一封' }),
    ])
  })
})

describe('handleDreamSlashCommand', () => {
  it('runs a manual dream through the controller', async () => {
    const u = ui()
    const controller = {
      runDreamNow: vi.fn().mockResolvedValue({
        run: { id: 'dream_1', status: 'completed' },
        deep: {
          dreamDiary: { summary: '整理了 Dream Runtime' },
          promptContext: { longHorizonObjective: '完成 Dream Runtime' },
        },
      }),
    }

    await handleDreamSlashCommand(cwd, '/dream run', { kind: 'dreamRun', mode: 'full' }, controller, u)

    expect(u.setNotice).toHaveBeenCalledWith(expect.stringContaining('我开始做梦了'))
    expect(controller.runDreamNow).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'full',
      source: 'manual',
      writeInbox: true,
    }))
    expect(u.deliverLocalCommandExchange).toHaveBeenCalledWith('/dream run', expect.stringContaining('Dream run completed'))
    expect(u.setInput).toHaveBeenCalledWith('')
  })

  it('shows latest diary and prompt context', async () => {
    const u = ui()
    await saveDreamDiary(cwd, {
      id: 'diary_1',
      createdAt: '2026-05-05T04:00:00.000Z',
      title: '我的梦境笔记',
      summary: '梦到了 Dream Runtime。',
      whatHappened: ['做了梦'],
      whatIUnderstood: ['不要把完整梦境塞进 prompt'],
      memoriesChanged: [],
      metaStateChanges: [],
      currentObjective: '完成单机 Dream Runtime',
      creativeInsights: ['Dream Context 可以是一条行动摘要。'],
      visibleToUser: true,
    })
    await saveDreamPromptContext(cwd, {
      updatedAt: '2026-05-05T04:00:00.000Z',
      longHorizonObjective: '完成单机 Dream Runtime',
      recentInsight: 'Dream Context 是梦醒后的行动摘要。',
      relevantStableMemories: [],
      behaviorGuidance: ['保持单机设计'],
      unresolvedThreads: [],
      cautions: [],
    })

    await handleDreamSlashCommand(cwd, '/dream diary', { kind: 'dreamDiary' }, null, u)
    expect(u.deliverLocalCommandExchange).toHaveBeenCalledWith('/dream diary', expect.stringContaining('不要把完整梦境塞进 prompt'))

    await handleDreamSlashCommand(cwd, '/dream context', { kind: 'dreamContext' }, null, u)
    expect(u.deliverLocalCommandExchange).toHaveBeenCalledWith('/dream context', expect.stringContaining('## Dream Context'))
  })
})

describe('handleRollSlashCommand', () => {
  it('rolls back assistant output layers and persists the result', async () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
      { role: 'user' as const, content: 'again' },
    ]
    await saveSession(cwd, messages)
    const setMessages = vi.fn()
    const u = { ...ui(), setMessages }

    await handleRollSlashCommand(cwd, messages, { kind: 'roll', layers: 1 }, u)

    expect(setMessages).toHaveBeenCalledWith([])
    expect((await loadSession(cwd))?.messages).toEqual([])
    expect(u.setNotice).toHaveBeenCalledWith(expect.stringContaining('已回滚 1 层'))
  })
})

describe('handleCompactSlashCommand', () => {
  it('delegates compaction to the provided controller and updates UI when it completes', async () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ]
    const nextMessages = [{ role: 'assistant' as const, content: 'summary' }]
    const compactController = {
      compactSessionAsync: vi.fn().mockResolvedValue(nextMessages),
    }
    const u = { ...ui(), setMessages: vi.fn(), setCompacting: vi.fn() }

    handleCompactSlashCommand(
      cwd,
      makeConfig({ minTailMessages: 5, maxToolSnippetChars: 1200 }),
      messages,
      { kind: 'compact', instructions: '保留结论' },
      compactController,
      u,
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(compactController.compactSessionAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        messages,
        minTailMessages: 5,
        maxToolSnippetChars: 1200,
        customInstructions: '保留结论',
      }),
    )
    expect(u.setCompacting).toHaveBeenNthCalledWith(1, true)
    expect(u.setMessages).toHaveBeenCalledWith(nextMessages)
    expect(u.clearNoticeLater).toHaveBeenCalledWith(5000)
    expect(u.setCompacting).toHaveBeenLastCalledWith(false)
  })
})

describe('handleUndoSlashCommand', () => {
  it('restores the latest edit snapshot and pops history', async () => {
    const filePath = join(cwd, 'file.txt')
    await writeFile(filePath, 'new', 'utf8')
    const history = new EditHistory()
    history.push({ relPath: 'file.txt', previous: 'old' })
    const u = ui()

    await handleUndoSlashCommand(cwd, history, u)

    expect(await readFile(filePath, 'utf8')).toBe('old')
    expect(history.depth).toBe(0)
    expect(u.setNotice).toHaveBeenCalledWith('已撤销: file.txt')
  })

  it('reports empty edit history without touching input state elsewhere', async () => {
    const history = new EditHistory()
    const u = ui()

    await handleUndoSlashCommand(cwd, history, u)

    expect(u.setError).toHaveBeenCalledWith(expect.stringContaining('没有可撤销的编辑'))
    expect(u.setInput).toHaveBeenCalledWith('')
  })
})

describe('simple local command handlers', () => {
  it('handles exit, clear, reload, and help command plumbing', async () => {
    const messages = [{ role: 'user' as const, content: 'hello' }]
    const exitApp = vi.fn()
    await handleExitSlashCommand(cwd, messages, exitApp)
    expect((await loadSession(cwd))?.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello' }),
    ])
    expect(exitApp).toHaveBeenCalled()

    const clearUi = { setMessages: vi.fn(), setInput: vi.fn() }
    await handleClearSlashCommand(cwd, messages, clearUi)
    expect(clearUi.setMessages).toHaveBeenCalledWith([])
    expect((await loadSession(cwd))?.messages).toEqual([])
    expect((await searchSessions(cwd, 'hello', 5)).length).toBeGreaterThan(0)

    const reloadAll = vi.fn(async () => {})
    await handleReloadSlashCommand(reloadAll, clearUi)
    expect(reloadAll).toHaveBeenCalled()

    const u = ui()
    handleHelpSlashCommand(u)
    expect(u.setError).toHaveBeenCalledWith(expect.stringContaining('/config'))
  })

  it('formats memory and permission messages', () => {
    const u = ui()
    handleMemorySlashCommand(u)
    expect(u.setError).toHaveBeenCalledWith(expect.stringContaining('memory.json'))
    expect(u.setInput).toHaveBeenCalledWith('')

    handlePermissionSlashCommand({ kind: 'permission' }, true, u)
    expect(u.setNotice).toHaveBeenCalledWith(expect.stringContaining('全部跳过'))
    expect(u.clearNoticeLater).toHaveBeenCalledWith(8000)
  })

  it('handles config and debug LiveUI commands', () => {
    const u = ui()
    const liveUi = { openConfigPanel: vi.fn() }
    handleConfigSlashCommand('/project', { version: 1 }, liveUi, u)
    expect(liveUi.openConfigPanel).toHaveBeenCalledWith('/project', { version: 1 })
    expect(u.setNotice).toHaveBeenCalledWith('已打开 Live 配置面板')

    const setDebugOverlayEnabled = vi.fn()
    const debugController = { setDebugOverlayEnabled: vi.fn() }
    handleDebugSlashCommand({}, false, setDebugOverlayEnabled, debugController, u)
    expect(setDebugOverlayEnabled).toHaveBeenCalledWith(true)
    expect(debugController.setDebugOverlayEnabled).toHaveBeenCalledWith(true)
    expect(u.setNotice).toHaveBeenCalledWith('LiveUI debug 已开启')
  })

  it('handles speak command TTS routing', () => {
    const u = ui()
    const liveUi = {
      hasTts: true,
      resetAudio: vi.fn(),
      enqueueTts: vi.fn(),
    }
    handleSpeakSlashCommand('第一句。\n\n第二句。', liveUi, u)
    expect(liveUi.resetAudio).toHaveBeenCalled()
    expect(liveUi.enqueueTts).toHaveBeenCalledWith('第一句。')
    expect(liveUi.enqueueTts).toHaveBeenCalledWith('第二句。')

    handleSpeakSlashCommand('', liveUi, u)
    expect(u.setError).toHaveBeenCalledWith(expect.stringContaining('/speak 后请输入'))
  })
})
