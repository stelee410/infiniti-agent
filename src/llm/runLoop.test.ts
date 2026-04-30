import { describe, expect, it, vi } from 'vitest'
import type { InfinitiConfig } from '../config/types.js'
import type { McpManager } from '../mcp/manager.js'

type StreamHandler = (event: unknown) => void

class FakeAnthropic {
  messages = {
    stream: () => {
      const handlers = new Map<string, StreamHandler[]>()
      return {
        on: (name: string, fn: StreamHandler) => {
          handlers.set(name, [...(handlers.get(name) ?? []), fn])
        },
        abort: vi.fn(),
        finalMessage: async () => {
          for (const fn of handlers.get('streamEvent') ?? []) {
            fn({
              type: 'content_block_start',
              content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file' },
            })
            fn({
              type: 'content_block_delta',
              delta: { type: 'input_json_delta', partial_json: '{"path":"package.json"}' },
            })
            fn({ type: 'content_block_stop' })
          }
          throw new Error('stream dropped')
        },
      }
    },
  }
}

vi.mock('@anthropic-ai/sdk', () => ({ default: FakeAnthropic }))

const { canBypassToolSafetyForDryRun, runToolLoop } = await import('./runLoop.js')

describe('canBypassToolSafetyForDryRun', () => {
  it('only bypasses safety for supported edit previews', () => {
    expect(canBypassToolSafetyForDryRun('write_file', { dry_run: true })).toBe(true)
    expect(canBypassToolSafetyForDryRun('str_replace', { dry_run: true })).toBe(true)
  })

  it('does not bypass safety for tools that do real work', () => {
    expect(canBypassToolSafetyForDryRun('bash', { dry_run: true })).toBe(false)
    expect(canBypassToolSafetyForDryRun('http_request', { dry_run: true })).toBe(false)
    expect(canBypassToolSafetyForDryRun('some_mcp_tool', { dry_run: true })).toBe(false)
  })
})

describe('runToolLoop Anthropic stream recovery', () => {
  it('records already-dispatched tool results when the stream fails', async () => {
    const config: InfinitiConfig = {
      version: 1,
      llm: {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-test',
        apiKey: 'test-key',
      },
    }

    const result = await runToolLoop({
      config,
      system: 'test',
      messages: [{ role: 'user', content: 'read package' }],
      cwd: process.cwd(),
      mcp: { getToolSpecs: () => [], call: async () => '{}' } as unknown as McpManager,
      skipPermissions: true,
    })

    expect(result.messages.at(-3)).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'tool-1', name: 'read_file' }],
    })
    expect(result.messages.at(-2)).toMatchObject({
      role: 'tool',
      toolCallId: 'tool-1',
      name: 'read_file',
    })
    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('stream dropped'),
    })
  })
})
