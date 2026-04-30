import { describe, expect, it, vi } from 'vitest'
import {
  finalizeQueuedMediaCommand,
  parseQueuedMediaCommand,
  queuedMediaEmptyPromptMessage,
  queuedMediaNotice,
  runQueuedMediaCommand,
  type QueuedMediaLiveUi,
} from './queuedMediaCommand.js'
import type { PersistedMessage } from '../llm/persisted.js'

describe('parseQueuedMediaCommand', () => {
  it('parses supported media commands and trims prompts', () => {
    expect(parseQueuedMediaCommand('/avatargen  城市猎人  ')).toEqual({
      kind: 'avatargen',
      prefix: '/avatargen',
      prompt: '城市猎人',
    })
    expect(parseQueuedMediaCommand('/seedance  夕阳海边  ')).toEqual({
      kind: 'video',
      prefix: '/seedance',
      prompt: '夕阳海边',
    })
    expect(parseQueuedMediaCommand('/video')).toEqual({
      kind: 'video',
      prefix: '/video',
      prompt: '',
    })
    expect(parseQueuedMediaCommand('/snap 咖啡馆')).toEqual({
      kind: 'snap',
      prefix: '/snap',
      prompt: '咖啡馆',
    })
    expect(parseQueuedMediaCommand('/snapshot 咖啡馆')).toBeNull()
  })

  it('formats empty-prompt messages and queued notices by command kind', () => {
    const seedance = parseQueuedMediaCommand('/seedance')!
    expect(queuedMediaEmptyPromptMessage(seedance)).toContain('/seedance 后请输入提示词')
    expect(queuedMediaNotice('avatargen')).toContain('AvatarGen')
    expect(queuedMediaNotice('video')).toContain('Seedance')
    expect(queuedMediaNotice('snap')).toContain('图片任务')
  })
})

describe('runQueuedMediaCommand', () => {
  function runner(overrides: Partial<Parameters<typeof runQueuedMediaCommand<string, string, string, string>>[0]> = {}) {
    return {
      getVision: vi.fn(() => 'vision'),
      getFileAttachments: vi.fn(() => ['file']),
      clearVisionAttachment: vi.fn(),
      clearFileAttachments: vi.fn(),
      avatarReferences: vi.fn((vision?: string, files: string[] = []) => [vision ?? 'none', ...files]),
      videoReferences: vi.fn((vision?: string, files: string[] = []) => [vision ?? 'none', ...files]),
      enqueueAvatar: vi.fn(async () => ({ id: 'avatar-job' })),
      enqueueVideo: vi.fn(async () => ({ id: 'video-job' })),
      enqueueSnap: vi.fn(async () => ({ id: 'snap-job' })),
      polishAvatar: vi.fn(async (_prompt: string, jobId: string) => `avatar:${jobId}`),
      polishVideo: vi.fn(async (_prompt: string, jobId: string) => `video:${jobId}`),
      polishSnap: vi.fn(async (_prompt: string, jobId: string) => `snap:${jobId}`),
      ...overrides,
    }
  }

  it('routes avatar commands through avatar references and clears consumed vision', async () => {
    const r = runner()
    const content = await runQueuedMediaCommand({
      command: parseQueuedMediaCommand('/avatargen portrait')!,
      ...r,
    })

    expect(content).toBe('avatar:avatar-job')
    expect(r.avatarReferences).toHaveBeenCalledWith('vision', ['file'])
    expect(r.enqueueAvatar).toHaveBeenCalledWith('portrait', ['vision', 'file'])
    expect(r.clearVisionAttachment).toHaveBeenCalled()
    expect(r.clearFileAttachments).not.toHaveBeenCalled()
  })

  it('routes video commands and clears file attachments when no vision is used', async () => {
    const r = runner({ getVision: vi.fn(() => undefined) })
    const content = await runQueuedMediaCommand({
      command: parseQueuedMediaCommand('/video sunset')!,
      ...r,
    })

    expect(content).toBe('video:video-job')
    expect(r.videoReferences).toHaveBeenCalledWith(undefined, ['file'])
    expect(r.clearVisionAttachment).not.toHaveBeenCalled()
    expect(r.clearFileAttachments).toHaveBeenCalled()
  })

  it('routes snap commands through the snap queue without consuming file attachments', async () => {
    const r = runner()
    const content = await runQueuedMediaCommand({
      command: parseQueuedMediaCommand('/snap cafe')!,
      ...r,
    })

    expect(content).toBe('snap:snap-job')
    expect(r.getFileAttachments).not.toHaveBeenCalled()
    expect(r.enqueueSnap).toHaveBeenCalledWith('cafe', 'vision')
    expect(r.clearVisionAttachment).toHaveBeenCalled()
  })
})

describe('finalizeQueuedMediaCommand', () => {
  it('appends the user command and assistant reply, saves, and updates notice', async () => {
    const messages: PersistedMessage[] = [{ role: 'user', content: 'hello' }]
    const saveSession = vi.fn(async () => {})
    const setMessages = vi.fn()
    const setNotice = vi.fn()
    const observeAssistantOutput = vi.fn()
    const clearNoticeLater = vi.fn()

    const next = await finalizeQueuedMediaCommand({
      cwd: '/tmp/project',
      messages,
      rawCommand: '/snap coffee',
      assistantContent: '我去生成这张图。',
      cleanForTts: (content) => content,
      observeAssistantOutput,
      saveSession,
      setMessages,
      setNotice,
      clearNoticeLater,
    })

    expect(next).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: '/snap coffee' },
      { role: 'assistant', content: '我去生成这张图。' },
    ])
    expect(observeAssistantOutput).toHaveBeenCalledWith('我去生成这张图。')
    expect(setMessages).toHaveBeenCalledWith(next)
    expect(saveSession).toHaveBeenCalledWith('/tmp/project', next)
    expect(setNotice).toHaveBeenCalledWith('我去生成这张图。')
    expect(clearNoticeLater).toHaveBeenCalledWith(12000)
  })

  it('streams the reply and queues clean TTS segments for LiveUI', async () => {
    const liveUi: QueuedMediaLiveUi = {
      hasTts: true,
      sendAssistantStream: vi.fn(),
      resetAudio: vi.fn(),
      enqueueTts: vi.fn(),
    }

    await finalizeQueuedMediaCommand({
      cwd: '/tmp/project',
      messages: [],
      rawCommand: '/video sunset',
      assistantContent: '第一句。\n\n第二句。',
      liveUi,
      cleanForTts: (content) => content.replace('第二句', '干净第二句'),
      saveSession: vi.fn(async () => {}),
      setMessages: vi.fn(),
      setNotice: vi.fn(),
    })

    expect(liveUi.sendAssistantStream).toHaveBeenCalledWith('第一句。\n\n第二句。', true, true)
    expect(liveUi.resetAudio).toHaveBeenCalled()
    expect(liveUi.enqueueTts).toHaveBeenCalledWith('第一句。')
    expect(liveUi.enqueueTts).toHaveBeenCalledWith('干净第二句。')
  })
})
