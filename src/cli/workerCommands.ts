import { runAvatarGenJob } from '../avatar/asyncAvatarGen.js'
import { runSnapPhotoJob } from '../snap/asyncSnap.js'
import { runSeedanceVideoJob } from '../video/asyncVideo.js'

export type WorkerCommandName = 'snap-worker' | 'video-worker' | 'avatargen-worker'

export type ParsedWorkerCommand = {
  name: WorkerCommandName
  jobPath?: string
}

export type WorkerCommandRunners = {
  runSnapPhotoJob: (jobPath: string) => Promise<void>
  runSeedanceVideoJob: (jobPath: string) => Promise<void>
  runAvatarGenJob: (jobPath: string) => Promise<void>
}

export type WorkerCommandIo = {
  error(message: string): void
  exit(code: number): never
}

const WORKER_COMMANDS = new Set<WorkerCommandName>([
  'snap-worker',
  'video-worker',
  'avatargen-worker',
])

export function parseWorkerCommand(argv: string[]): ParsedWorkerCommand | null {
  const name = argv[0]
  if (!WORKER_COMMANDS.has(name as WorkerCommandName)) return null
  return {
    name: name as WorkerCommandName,
    jobPath: argv[1],
  }
}

export function workerUsage(name: WorkerCommandName): string {
  return `用法: infiniti-agent ${name} <job.json>`
}

export async function runWorkerCommand(
  command: ParsedWorkerCommand,
  runners: WorkerCommandRunners = {
    runSnapPhotoJob,
    runSeedanceVideoJob,
    runAvatarGenJob,
  },
  io: WorkerCommandIo = {
    error: (message) => console.error(message),
    exit: (code) => process.exit(code),
  },
): Promise<true> {
  if (!command.jobPath) {
    io.error(workerUsage(command.name))
    io.exit(2)
  }

  try {
    if (command.name === 'snap-worker') {
      await runners.runSnapPhotoJob(command.jobPath)
    } else if (command.name === 'video-worker') {
      await runners.runSeedanceVideoJob(command.jobPath)
    } else {
      await runners.runAvatarGenJob(command.jobPath)
    }
  } catch (e) {
    io.error((e as Error).message)
    io.exit(2)
  }
  return true
}
