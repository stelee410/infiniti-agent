import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  addScheduleTask,
  advanceScheduleTask,
  dueScheduleTasks,
  loadScheduleStore,
} from './store.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-schedule-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('schedule store', () => {
  it('persists tasks and finds missed due tasks', async () => {
    const task = await addScheduleTask(cwd, {
      kind: 'once',
      prompt: '检查邮箱',
      nextRunAt: new Date('2026-04-29T00:00:00.000Z'),
    })
    const store = await loadScheduleStore(cwd)
    expect(store.tasks[0]?.id).toBe(task.id)
    expect(dueScheduleTasks(store, new Date('2026-04-30T00:00:00.000Z')).map((t) => t.id)).toEqual([task.id])
  })

  it('advances fast interval tasks from current heartbeat time', () => {
    const task = advanceScheduleTask({
      version: 1,
      id: 'sch_test',
      enabled: true,
      kind: 'interval',
      prompt: 'ping',
      createdAt: '2026-04-29T00:00:00.000Z',
      nextRunAt: '2026-04-29T00:00:00.000Z',
      intervalMs: 10000,
      runCount: 0,
    }, new Date('2026-04-29T00:01:00.000Z'))
    expect(task.nextRunAt).toBe('2026-04-29T00:01:10.000Z')
    expect(task.runCount).toBe(1)
  })
})
