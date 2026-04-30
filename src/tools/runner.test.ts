import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { runBuiltinTool, type ToolRunContext } from './runner.js'
import { loadMemoryStore } from '../memory/structured.js'
import { loadProfileStore } from '../memory/userProfile.js'
import { loadScheduleStore, saveScheduleStore } from '../schedule/store.js'
import type { InfinitiConfig } from '../config/types.js'

const testConfig: InfinitiConfig = {
  version: 1,
  llm: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    apiKey: 'test-key',
  },
}

let cwd: string
let ctx: ToolRunContext

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-runner-test-'))
  ctx = { sessionCwd: cwd, config: testConfig }
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('memory tool dispatch', () => {
  it('handles add action', async () => {
    const result = await runBuiltinTool(
      'memory',
      JSON.stringify({ action: 'add', title: 'test', body: 'test body', tag: 'fact' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)

    const store = await loadMemoryStore(cwd)
    expect(store.entries).toHaveLength(1)
  })

  it('handles list action', async () => {
    await runBuiltinTool(
      'memory',
      JSON.stringify({ action: 'add', title: 'a', body: 'b' }),
      ctx,
    )
    const result = await runBuiltinTool(
      'memory',
      JSON.stringify({ action: 'list' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.entries).toHaveLength(1)
  })

  it('handles remove action', async () => {
    await runBuiltinTool(
      'memory',
      JSON.stringify({ action: 'add', title: 'del', body: 'to delete' }),
      ctx,
    )
    const store = await loadMemoryStore(cwd)
    const id = store.entries[0]!.id

    const result = await runBuiltinTool(
      'memory',
      JSON.stringify({ action: 'remove', id }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)

    const after = await loadMemoryStore(cwd)
    expect(after.entries).toHaveLength(0)
  })

  it('rejects invalid action', async () => {
    const result = await runBuiltinTool(
      'memory',
      JSON.stringify({ action: 'invalid' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
  })
})

describe('user_profile tool dispatch', () => {
  it('handles add action', async () => {
    const result = await runBuiltinTool(
      'user_profile',
      JSON.stringify({ action: 'add', title: 'pref', body: 'likes TS', tag: 'tech_stack' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)

    const store = await loadProfileStore(cwd)
    expect(store.entries).toHaveLength(1)
  })

  it('handles list action', async () => {
    await runBuiltinTool(
      'user_profile',
      JSON.stringify({ action: 'add', title: 'x', body: 'y' }),
      ctx,
    )
    const result = await runBuiltinTool(
      'user_profile',
      JSON.stringify({ action: 'list' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.entries).toHaveLength(1)
  })
})

describe('search_sessions tool dispatch', () => {
  it('rejects empty query', async () => {
    const result = await runBuiltinTool(
      'search_sessions',
      JSON.stringify({ query: '' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
  })

  it('returns results for valid query on empty db', async () => {
    const result = await runBuiltinTool(
      'search_sessions',
      JSON.stringify({ query: 'test' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.results).toHaveLength(0)
  })
})

describe('manage_skill tool dispatch', () => {
  it('creates a skill', async () => {
    const result = await runBuiltinTool(
      'manage_skill',
      JSON.stringify({ action: 'create', name: 'my-skill', content: '# My Skill\n\nDo things.' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.path).toContain('my-skill')
  })

  it('rejects empty name', async () => {
    const result = await runBuiltinTool(
      'manage_skill',
      JSON.stringify({ action: 'create', name: '', content: 'x' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
  })

  it('rejects invalid action', async () => {
    const result = await runBuiltinTool(
      'manage_skill',
      JSON.stringify({ action: 'invalid', name: 'x' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
  })
})

describe('knowledge_graph tool dispatch', () => {
  it('handles stats action', async () => {
    const result = await runBuiltinTool(
      'knowledge_graph',
      JSON.stringify({ action: 'stats' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.results.totalTriples).toBe(0)
  })

  it('handles add and query', async () => {
    await runBuiltinTool(
      'knowledge_graph',
      JSON.stringify({
        action: 'add',
        subject: 'Node',
        predicate: 'version',
        object: '20',
      }),
      ctx,
    )

    const result = await runBuiltinTool(
      'knowledge_graph',
      JSON.stringify({ action: 'query', entity: 'Node' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.results).toHaveLength(1)
  })

  it('rejects invalid action', async () => {
    const result = await runBuiltinTool(
      'knowledge_graph',
      JSON.stringify({ action: 'bogus' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
  })
})

describe('update_memory legacy tool', () => {
  it('still works for backward compat', async () => {
    const result = await runBuiltinTool(
      'update_memory',
      JSON.stringify({ body: 'legacy entry' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.message).toContain('memory')
  })
})

describe('schedule tool dispatch', () => {
  it('creates a one-off schedule task from structured LLM args', async () => {
    const result = await runBuiltinTool(
      'schedule',
      JSON.stringify({
        action: 'create',
        kind: 'once',
        prompt: '好好休息',
        next_run_at: '2026-04-29T23:00:00+08:00',
      }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)

    const store = await loadScheduleStore(cwd)
    expect(store.tasks).toHaveLength(1)
    expect(store.tasks[0]!.prompt).toBe('好好休息')
    expect(store.tasks[0]!.kind).toBe('once')
  })

  it('lists and removes schedule tasks', async () => {
    const created = JSON.parse(await runBuiltinTool(
      'schedule',
      JSON.stringify({
        action: 'create',
        kind: 'daily',
        prompt: 'read Hacker News',
        time_of_day: '08:30',
      }),
      ctx,
    ))
    expect(created.ok).toBe(true)

    const listed = JSON.parse(await runBuiltinTool('schedule', JSON.stringify({ action: 'list' }), ctx))
    expect(listed.ok).toBe(true)
    expect(listed.count).toBe(1)

    const removed = JSON.parse(await runBuiltinTool(
      'schedule',
      JSON.stringify({ action: 'remove', id: created.task.id.slice(0, 12) }),
      ctx,
    ))
    expect(removed.ok).toBe(true)
  })

  it('clears completed schedule tasks', async () => {
    const created = JSON.parse(await runBuiltinTool(
      'schedule',
      JSON.stringify({
        action: 'create',
        kind: 'once',
        prompt: 'single run',
        next_run_at: '2026-04-29T23:00:00+08:00',
      }),
      ctx,
    ))
    expect(created.ok).toBe(true)

    const store = await loadScheduleStore(cwd)
    store.tasks[0]!.enabled = false
    await saveScheduleStore(cwd, store)

    const cleared = JSON.parse(await runBuiltinTool('schedule', JSON.stringify({ action: 'clear' }), ctx))
    expect(cleared.ok).toBe(true)
    expect(cleared.removedCount).toBe(1)
  })
})

describe('invalid JSON args', () => {
  it('returns error for malformed JSON', async () => {
    const result = await runBuiltinTool('memory', 'not json', ctx)
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('JSON')
  })

  it('returns error for unknown builtin tool names', async () => {
    const result = await runBuiltinTool(
      'missing_tool' as Parameters<typeof runBuiltinTool>[0],
      JSON.stringify({}),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('未知')
  })
})

describe('workspace safety guards', () => {
  it('rejects glob patterns that escape the workspace', async () => {
    const result = await runBuiltinTool(
      'glob_files',
      JSON.stringify({ pattern: '../*.sh' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('工作区')
  })

  it('does not return paths outside the workspace from glob', async () => {
    await writeFile(join(cwd, 'inside.txt'), 'ok', 'utf8')
    const result = await runBuiltinTool(
      'glob_files',
      JSON.stringify({ pattern: '**/*.txt' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.files).toEqual(['inside.txt'])
  })

  it('rejects bash cwd outside the workspace', async () => {
    const result = await runBuiltinTool(
      'bash',
      JSON.stringify({ command: 'pwd', cwd: '..' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('工作区')
  })

  it('blocks local and private HTTP targets before fetch', async () => {
    for (const url of [
      'http://[::1]:8080/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      const result = await runBuiltinTool(
        'http_request',
        JSON.stringify({ method: 'GET', url }),
        ctx,
      )
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain('已阻止')
    }
  })
})

describe('seedance_video tool dispatch', () => {
  it('rejects empty prompt', async () => {
    const result = await runBuiltinTool(
      'seedance_video',
      JSON.stringify({ prompt: '' }),
      ctx,
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('prompt')
  })
})
