import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { InfinitiConfig } from '../config/types.js'
import { loadConfig } from '../config/io.js'
import { localJobsDir } from '../paths.js'
import { executeMemoryAction } from '../memory/structured.js'
import { writeInboxMessage } from '../inbox/store.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { loadSession, saveSession } from '../session/file.js'
import {
  generateReal2dAvatarSet,
  resolveReal2dAvatarGenAuth,
  type AvatarGenReferenceImage,
} from './real2dAvatarGen.js'

export type AvatarGenJob = {
  version: 1
  id: string
  cwd: string
  prompt: string
  createdAt: string
  referenceImages: AvatarGenReferenceImage[]
}

export type EnqueuedAvatarGenJob = {
  id: string
  jobPath: string
}

function jobFileName(id: string): string {
  return `${id}.json`
}

async function appendJobLog(cwd: string, line: string): Promise<void> {
  try {
    const dir = join(cwd, '.infiniti-agent')
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, 'avatargen-async.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* best effort diagnostics */
  }
}

function currentCliInvocation(cwd: string, jobPath: string): { command: string; args: string[] } {
  const entry = process.argv[1]
  if (!entry) {
    return { command: 'infiniti-agent', args: ['avatargen-worker', jobPath] }
  }
  if (/\.(tsx?|mts|cts)$/i.test(entry)) {
    const localTsx = join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
    return {
      command: existsSync(localTsx) ? localTsx : 'npx',
      args: existsSync(localTsx)
        ? [entry, 'avatargen-worker', jobPath]
        : ['tsx', entry, 'avatargen-worker', jobPath],
    }
  }
  return {
    command: process.execPath,
    args: [...process.execArgv, entry, 'avatargen-worker', jobPath],
  }
}

export async function enqueueAvatarGenJob(
  cwd: string,
  cfg: InfinitiConfig,
  prompt: string,
  referenceImages: AvatarGenReferenceImage[],
): Promise<EnqueuedAvatarGenJob> {
  resolveReal2dAvatarGenAuth(cfg)

  const id = `avatargen_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`
  const dir = localJobsDir(cwd)
  await mkdir(dir, { recursive: true })
  const job: AvatarGenJob = {
    version: 1,
    id,
    cwd,
    prompt,
    createdAt: new Date().toISOString(),
    referenceImages,
  }
  const jobPath = join(dir, jobFileName(id))
  await writeFile(jobPath, JSON.stringify(job, null, 2) + '\n', 'utf8')

  const childSpec = currentCliInvocation(cwd, jobPath)
  const child = spawn(childSpec.command, childSpec.args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  await appendJobLog(cwd, `enqueued id=${id} job=${jobPath} refs=${referenceImages.length} pid=${child.pid ?? 'unknown'}`)
  await executeMemoryAction(cwd, {
    action: 'add',
    title: `Real2D 表情集生成已排队: ${prompt.slice(0, 32)}`,
    body: `用户请求异步生成 Real2D 表情 PNG 套装，任务已排队。任务 ID: ${id}\n提示词: ${prompt}`,
    tag: 'fact',
  }).catch(() => undefined)
  return { id, jobPath }
}

function validateJob(raw: unknown): AvatarGenJob {
  if (!raw || typeof raw !== 'object') throw new Error('job 格式无效')
  const j = raw as Partial<AvatarGenJob>
  if (j.version !== 1) throw new Error('不支持的 job version')
  if (typeof j.id !== 'string' || !j.id.trim()) throw new Error('job 缺少 id')
  if (typeof j.cwd !== 'string' || !j.cwd.trim()) throw new Error('job 缺少 cwd')
  if (typeof j.prompt !== 'string') throw new Error('job 缺少 prompt')
  if (typeof j.createdAt !== 'string' || !j.createdAt.trim()) throw new Error('job 缺少 createdAt')
  if (!Array.isArray(j.referenceImages)) throw new Error('job 缺少 referenceImages')
  return j as AvatarGenJob
}

function warmSuccessText(prompt: string, dir: string): string {
  return [
    '你刚才托我生成的 Real2D 表情集已经完成啦。',
    '',
    `输出目录：${dir}`,
    '',
    '我生成了 `exp01.png` 到 `exp06.png`，以及用于说话口型的 `exp_open.png`。',
    prompt.trim() ? `这次的附加要求是：「${prompt.trim()}」。` : '',
  ].filter(Boolean).join('\n')
}

function warmFailureText(prompt: string, error: string): string {
  return [
    '你刚才托我生成的 Real2D 表情集这次没有成功。',
    '',
    prompt.trim() ? `请求是：「${prompt.trim()}」` : '',
    `失败原因：${error}`,
  ].filter(Boolean).join('\n')
}

async function polishAvatarGenText(
  cfg: InfinitiConfig,
  fallback: string,
  context: string,
): Promise<string> {
  try {
    const out = await oneShotTextCompletion({
      config: cfg,
      maxOutTokens: 700,
      system:
        '你是 Infiniti Agent 的温柔人格文案助手。请只输出中文正文，不要标题，不要 Markdown 图片语法。语气亲近、克制、温暖，像对熟人汇报一个异步 AvatarGen 任务。把用户收件处称为“你的邮箱”。保留必要的输出目录、文件名、任务状态和失败原因，不要编造结果。',
      user: `请润色下面这段邮箱/对话通知，意思不能变：\n\n${context}`,
    })
    return out.trim() || fallback
  } catch {
    return fallback
  }
}

async function appendAssistantSessionMessage(cwd: string, content: string): Promise<void> {
  if (!content.trim()) return
  const session = await loadSession(cwd)
  const messages: PersistedMessage[] = session?.messages ?? []
  await saveSession(cwd, [...messages, { role: 'assistant', content }])
}

export async function runAvatarGenJob(jobPath: string): Promise<void> {
  const raw = JSON.parse(await readFile(jobPath, 'utf8')) as unknown
  const job = validateJob(raw)
  await appendJobLog(job.cwd, `start id=${job.id} file=${basename(jobPath)}`)
  try {
    const cfg = await loadConfig(job.cwd)
    const result = await generateReal2dAvatarSet(job.cwd, cfg, job.prompt, job.referenceImages)
    const fallbackBody = warmSuccessText(job.prompt, result.dir)
    const alphaWarnings = result.files.filter((f) => !f.hasAlpha).map((f) => f.name)
    const polishedBody = await polishAvatarGenText(
      cfg,
      fallbackBody,
      [
        '状态：Real2D 表情集生成成功',
        `用户提示词：${job.prompt}`,
        `输出目录：${result.dir}`,
        `文件：${result.files.map((f) => f.name).join(', ')}`,
        alphaWarnings.length ? `注意：这些文件未检测到 alpha 通道：${alphaWarnings.join(', ')}` : 'alpha 检查：全部文件检测到 alpha 通道',
        fallbackBody,
      ].join('\n'),
    )
    await writeInboxMessage(job.cwd, {
      id: `${job.id}_ok`,
      subject: 'Real2D 表情集生成完成',
      body: polishedBody,
      attachments: result.files.map((f) => ({
        kind: 'image' as const,
        path: f.path,
        label: f.name,
        mimeType: 'image/png',
      })),
      meta: {
        kind: 'avatargen-real2d',
        status: 'ok',
        jobId: job.id,
        provider: result.provider,
        model: result.model,
        outputDir: result.dir,
        files: result.files,
      },
    })
    await executeMemoryAction(job.cwd, {
      action: 'add',
      title: `Real2D 表情集生成完成: ${job.prompt.slice(0, 32)}`,
      body:
        `用户请求异步生成 Real2D 表情集。提示词: ${job.prompt}\n` +
        `输出目录: ${result.dir}\n文件: ${result.files.map((f) => f.name).join(', ')}`,
      tag: 'fact',
    }).catch(() => undefined)
    await appendAssistantSessionMessage(
      job.cwd,
      [
        '刚才的 Real2D 表情集已经生成好了，我把邮件和 PNG 附件放进了你的邮箱。',
        '',
        polishedBody,
      ].join('\n'),
    ).catch(() => undefined)
    await appendJobLog(job.cwd, `ok id=${job.id} dir=${result.dir}`)
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e)
    const cfg = await loadConfig(job.cwd).catch(() => null)
    const fallbackBody = warmFailureText(job.prompt, error)
    const polishedBody = cfg
      ? await polishAvatarGenText(
        cfg,
        fallbackBody,
        [
          '状态：Real2D 表情集生成失败',
          `用户提示词：${job.prompt}`,
          `失败原因：${error}`,
          fallbackBody,
        ].join('\n'),
      )
      : fallbackBody
    await writeInboxMessage(job.cwd, {
      id: `${job.id}_failed`,
      subject: 'Real2D 表情集生成失败',
      body: polishedBody,
      meta: { kind: 'avatargen-real2d', status: 'failed', jobId: job.id, error },
    }).catch(() => undefined)
    await executeMemoryAction(job.cwd, {
      action: 'add',
      title: `Real2D 表情集生成失败: ${job.prompt.slice(0, 32)}`,
      body: `用户请求异步生成 Real2D 表情集失败。提示词: ${job.prompt}\n失败原因: ${error}`,
      tag: 'lesson',
    }).catch(() => undefined)
    await appendAssistantSessionMessage(
      job.cwd,
      [
        '刚才的 Real2D 表情集任务没有成功，我把失败邮件放进了你的邮箱。',
        '',
        polishedBody,
      ].join('\n'),
    ).catch(() => undefined)
    await appendJobLog(job.cwd, `failed id=${job.id} error=${error}`)
    throw e
  }
}
