import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { executeKgAction, type Triple } from './knowledgeGraph.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-kg-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('executeKgAction — stats', () => {
  it('returns zero stats for empty graph', async () => {
    const res = await executeKgAction(cwd, { action: 'stats' })
    expect(res.ok).toBe(true)
    const stats = res.results as { totalTriples: number }
    expect(stats.totalTriples).toBe(0)
  })
})

describe('executeKgAction — add', () => {
  it('adds a triple', async () => {
    const res = await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'works_on',
      object: 'Project-X',
      valid_from: '2026-01-01',
    })
    expect(res.ok).toBe(true)
    expect(res.message).toContain('Alice')

    const stats = await executeKgAction(cwd, { action: 'stats' })
    expect((stats.results as { totalTriples: number }).totalTriples).toBe(1)
  })

  it('prevents duplicate active triples', async () => {
    await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'works_on',
      object: 'Project-X',
    })
    const res = await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'works_on',
      object: 'Project-X',
    })
    expect(res.ok).toBe(true)
    expect(res.message).toContain('已存在')

    const stats = await executeKgAction(cwd, { action: 'stats' })
    expect((stats.results as { totalTriples: number }).totalTriples).toBe(1)
  })

  it('rejects empty fields', async () => {
    const res = await executeKgAction(cwd, {
      action: 'add',
      subject: '',
      predicate: 'works_on',
      object: 'Project-X',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不能为空')
  })
})

describe('executeKgAction — invalidate', () => {
  it('invalidates an existing triple', async () => {
    await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'works_on',
      object: 'Project-X',
    })

    const res = await executeKgAction(cwd, {
      action: 'invalidate',
      subject: 'Alice',
      predicate: 'works_on',
      object: 'Project-X',
      ended: '2026-03-01',
    })
    expect(res.ok).toBe(true)

    // After invalidation, query for current should return nothing
    const query = await executeKgAction(cwd, {
      action: 'query',
      entity: 'Alice',
    })
    expect((query.results as Triple[]).length).toBe(0)
  })

  it('errors when no matching triple found', async () => {
    const res = await executeKgAction(cwd, {
      action: 'invalidate',
      subject: 'Nobody',
      predicate: 'does',
      object: 'nothing',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未找到')
  })
})

describe('executeKgAction — query', () => {
  it('queries current facts for an entity', async () => {
    await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'works_on',
      object: 'Project-X',
    })
    await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'knows',
      object: 'TypeScript',
    })

    const res = await executeKgAction(cwd, {
      action: 'query',
      entity: 'Alice',
    })
    expect(res.ok).toBe(true)
    const triples = res.results as Triple[]
    expect(triples.length).toBe(2)
  })

  it('queries facts as of a specific time', async () => {
    await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'works_on',
      object: 'Project-X',
      valid_from: '2025-01-01',
    })
    await executeKgAction(cwd, {
      action: 'invalidate',
      subject: 'Alice',
      predicate: 'works_on',
      object: 'Project-X',
      ended: '2025-06-01',
    })
    await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'works_on',
      object: 'Project-Y',
      valid_from: '2025-06-01',
    })

    // As of March 2025, Alice was on Project-X
    const march = await executeKgAction(cwd, {
      action: 'query',
      entity: 'Alice',
      as_of: '2025-03-15',
    })
    const marchTriples = march.results as Triple[]
    expect(marchTriples.length).toBe(1)
    expect(marchTriples[0]!.object).toBe('Project-X')

    // As of August 2025, Alice is on Project-Y
    const aug = await executeKgAction(cwd, {
      action: 'query',
      entity: 'Alice',
      as_of: '2025-08-15',
    })
    const augTriples = aug.results as Triple[]
    expect(augTriples.length).toBe(1)
    expect(augTriples[0]!.object).toBe('Project-Y')
  })

  it('finds entity as object too', async () => {
    await executeKgAction(cwd, {
      action: 'add',
      subject: 'Bob',
      predicate: 'manages',
      object: 'Alice',
    })

    const res = await executeKgAction(cwd, {
      action: 'query',
      entity: 'Alice',
    })
    const triples = res.results as Triple[]
    expect(triples.length).toBe(1)
    expect(triples[0]!.subject).toBe('Bob')
  })

  it('errors on empty entity', async () => {
    const res = await executeKgAction(cwd, {
      action: 'query',
      entity: '',
    })
    expect(res.ok).toBe(false)
  })
})

describe('executeKgAction — timeline', () => {
  it('returns chronological history of an entity', async () => {
    await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'joined',
      object: 'CompanyA',
      valid_from: '2023-01-01',
    })
    await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'promoted_to',
      object: 'Senior',
      valid_from: '2024-06-01',
    })
    await executeKgAction(cwd, {
      action: 'add',
      subject: 'Alice',
      predicate: 'works_on',
      object: 'Project-Z',
      valid_from: '2025-01-01',
    })

    const res = await executeKgAction(cwd, {
      action: 'timeline',
      entity: 'Alice',
    })
    expect(res.ok).toBe(true)
    const triples = res.results as Triple[]
    expect(triples.length).toBe(3)
  })
})
