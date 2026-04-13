import { describe, it, expect } from 'vitest'
import { messagesToCompactTranscript, truncateTranscriptAtBoundary } from './messagesTranscript.js'
import type { PersistedMessage } from './persisted.js'

describe('messagesToCompactTranscript', () => {
  it('formats user messages', () => {
    const msgs: PersistedMessage[] = [
      { role: 'user', content: '请帮我修复 bug' },
    ]
    const t = messagesToCompactTranscript(msgs, 4000)
    expect(t).toContain('### 用户')
    expect(t).toContain('请帮我修复 bug')
  })

  it('formats assistant text-only messages', () => {
    const msgs: PersistedMessage[] = [
      { role: 'assistant', content: '已修复', toolCalls: [] },
    ]
    const t = messagesToCompactTranscript(msgs, 4000)
    expect(t).toContain('### 助手')
    expect(t).toContain('已修复')
  })

  it('formats assistant with tool calls', () => {
    const msgs: PersistedMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: '1', name: 'bash', argumentsJson: '{"cmd":"ls"}' }],
      },
    ]
    const t = messagesToCompactTranscript(msgs, 4000)
    expect(t).toContain('[工具调用] bash')
  })

  it('formats tool results and groups consecutive tool messages', () => {
    const msgs: PersistedMessage[] = [
      { role: 'tool', toolCallId: '1', name: 'bash', content: 'file1' },
      { role: 'tool', toolCallId: '2', name: 'read_file', content: 'content' },
    ]
    const t = messagesToCompactTranscript(msgs, 4000)
    expect(t).toContain('### 工具结果')
    expect(t).toContain('- bash: file1')
    expect(t).toContain('- read_file: content')
    // Should be grouped under one heading
    const headingCount = (t.match(/### 工具结果/g) ?? []).length
    expect(headingCount).toBe(1)
  })

  it('snips long tool content to maxToolSnippetChars', () => {
    const msgs: PersistedMessage[] = [
      { role: 'tool', toolCallId: '1', name: 'bash', content: 'x'.repeat(5000) },
    ]
    const t = messagesToCompactTranscript(msgs, 500)
    expect(t).toContain('已截断')
    expect(t).toContain('共 5000 字符')
  })

  it('snips tool call argumentsJson to 2000 chars', () => {
    const msgs: PersistedMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: '1', name: 'write_file', argumentsJson: 'z'.repeat(3000) }],
      },
    ]
    const t = messagesToCompactTranscript(msgs, 4000)
    expect(t).toContain('已截断')
    expect(t).toContain('共 3000 字符')
  })

  it('shows （无正文） for assistant with null content and no tool calls', () => {
    const msgs: PersistedMessage[] = [
      { role: 'assistant', content: null },
    ]
    const t = messagesToCompactTranscript(msgs, 4000)
    expect(t).toContain('（无正文）')
  })

  it('handles a full conversation sequence', () => {
    const msgs: PersistedMessage[] = [
      { role: 'user', content: '列出文件' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'bash', argumentsJson: '{"cmd":"ls"}' }] },
      { role: 'tool', toolCallId: 'c1', name: 'bash', content: 'a.txt\nb.txt' },
      { role: 'assistant', content: '目录下有 2 个文件' },
    ]
    const t = messagesToCompactTranscript(msgs, 4000)
    expect(t).toContain('### 用户')
    expect(t).toContain('### 助手')
    expect(t).toContain('### 工具结果')
    expect(t).toContain('目录下有 2 个文件')
  })
})

describe('truncateTranscriptAtBoundary', () => {
  const block1 = '### 用户\n第一条消息'
  const block2 = '### 助手\n第二条消息'
  const block3 = '### 用户\n第三条消息'
  const full = [block1, block2, block3].join('\n\n')

  it('returns original if within limit', () => {
    expect(truncateTranscriptAtBoundary(full, full.length + 100)).toBe(full)
  })

  it('returns original for exact length', () => {
    expect(truncateTranscriptAtBoundary(full, full.length)).toBe(full)
  })

  it('truncates at message boundary (before block3)', () => {
    const limit = full.indexOf('\n\n### 用户\n第三条') + 5
    const result = truncateTranscriptAtBoundary(full, limit)
    expect(result).toContain(block1)
    expect(result).toContain(block2)
    expect(result).not.toContain('第三条消息')
    expect(result).toContain('已在消息边界处截断')
  })

  it('truncates at message boundary (before block2)', () => {
    const limit = block1.length + 5
    const result = truncateTranscriptAtBoundary(full, limit)
    expect(result).toContain('第一条消息')
    expect(result).not.toContain('第二条消息')
    expect(result).toContain('已在消息边界处截断')
  })

  it('falls back to hard cut when no boundary found before limit', () => {
    const singleBlock = '### 用户\n' + 'a'.repeat(1000)
    const result = truncateTranscriptAtBoundary(singleBlock, 50)
    expect(result.length).toBeLessThan(singleBlock.length)
    expect(result).toContain('已在消息边界处截断')
  })

  it('handles empty string', () => {
    expect(truncateTranscriptAtBoundary('', 100)).toBe('')
  })
})
