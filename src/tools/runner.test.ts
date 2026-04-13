import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { runBuiltinTool, type ToolRunContext } from './runner.js'
import { loadMemoryStore } from '../memory/structured.js'
import { loadProfileStore } from '../memory/userProfile.js'

let cwd: string
let ctx: ToolRunContext

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-runner-test-'))
  ctx = { sessionCwd: cwd }
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

describe('invalid JSON args', () => {
  it('returns error for malformed JSON', async () => {
    const result = await runBuiltinTool('memory', 'not json', ctx)
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('JSON')
  })
})
