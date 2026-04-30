import { describe, expect, it, vi } from 'vitest'
import { parseWorkerCommand, runWorkerCommand, workerUsage, type WorkerCommandIo } from './workerCommands.js'

function throwingIo(errors: string[]): WorkerCommandIo {
  return {
    error: (message) => errors.push(message),
    exit: (code) => {
      throw new Error(`exit:${code}`)
    },
  }
}

describe('workerCommands', () => {
  it('parses supported async worker commands', () => {
    expect(parseWorkerCommand(['snap-worker', '/tmp/snap.json'])).toEqual({
      name: 'snap-worker',
      jobPath: '/tmp/snap.json',
    })
    expect(parseWorkerCommand(['video-worker', '/tmp/video.json'])?.name).toBe('video-worker')
    expect(parseWorkerCommand(['avatargen-worker', '/tmp/avatar.json'])?.name).toBe('avatargen-worker')
    expect(parseWorkerCommand(['chat'])).toBeNull()
  })

  it('prints usage and exits when job path is missing', async () => {
    const errors: string[] = []
    await expect(runWorkerCommand(
      { name: 'snap-worker' },
      {
        runSnapPhotoJob: vi.fn(),
        runSeedanceVideoJob: vi.fn(),
        runAvatarGenJob: vi.fn(),
      },
      throwingIo(errors),
    )).rejects.toThrow('exit:2')
    expect(errors).toEqual([workerUsage('snap-worker')])
  })

  it('dispatches to the selected worker runner', async () => {
    const runners = {
      runSnapPhotoJob: vi.fn(async () => {}),
      runSeedanceVideoJob: vi.fn(async () => {}),
      runAvatarGenJob: vi.fn(async () => {}),
    }

    await runWorkerCommand(
      { name: 'video-worker', jobPath: '/tmp/job.json' },
      runners,
      throwingIo([]),
    )

    expect(runners.runSeedanceVideoJob).toHaveBeenCalledWith('/tmp/job.json')
    expect(runners.runSnapPhotoJob).not.toHaveBeenCalled()
    expect(runners.runAvatarGenJob).not.toHaveBeenCalled()
  })

  it('reports worker failures with exit code 2', async () => {
    const errors: string[] = []
    await expect(runWorkerCommand(
      { name: 'avatargen-worker', jobPath: '/tmp/job.json' },
      {
        runSnapPhotoJob: vi.fn(),
        runSeedanceVideoJob: vi.fn(),
        runAvatarGenJob: vi.fn(async () => {
          throw new Error('boom')
        }),
      },
      throwingIo(errors),
    )).rejects.toThrow('exit:2')
    expect(errors).toEqual(['boom'])
  })
})
