import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { InfinitiConfig } from '../config/types.js'
import { loadConfig } from '../config/io.js'
import type { LiveUiVisionAttachment } from '../liveui/protocol.js'
import { localJobsDir } from '../paths.js'
import { executeMemoryAction } from '../memory/structured.js'
import { writeInboxMessage } from '../inbox/store.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { loadSession, saveSession } from '../session/file.js'
import { generateSnapPhoto } from './generateSnap.js'

export type SnapJob = {
  version: 1
  id: string
  cwd: string
  prompt: string
  createdAt: string
  userVision?: LiveUiVisionAttachment
}

export type EnqueuedSnapJob = {
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
    await appendFile(join(dir, 'snap-async.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* best effort diagnostics */
  }
}

function currentCliInvocation(cwd: string, jobPath: string): { command: string; args: string[] } {
  const entry = process.argv[1]
  if (!entry) {
    return { command: 'infiniti-agent', args: ['snap-worker', jobPath] }
  }
  if (/\.(tsx?|mts|cts)$/i.test(entry)) {
    const localTsx = join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
    return {
      command: existsSync(localTsx) ? localTsx : 'npx',
      args: existsSync(localTsx)
        ? [entry, 'snap-worker', jobPath]
        : ['tsx', entry, 'snap-worker', jobPath],
    }
  }
  return {
    command: process.execPath,
    args: [...process.execArgv, entry, 'snap-worker', jobPath],
  }
}

export async function enqueueSnapPhotoJob(
  cwd: string,
  _config: InfinitiConfig,
  prompt: string,
  userVision?: LiveUiVisionAttachment,
): Promise<EnqueuedSnapJob> {
  const id = `snap_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`
  const dir = localJobsDir(cwd)
  await mkdir(dir, { recursive: true })
  const job: SnapJob = {
    version: 1,
    id,
    cwd,
    prompt,
    createdAt: new Date().toISOString(),
    ...(userVision ? { userVision } : {}),
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
  await appendJobLog(cwd, `enqueued id=${id} job=${jobPath} pid=${child.pid ?? 'unknown'}`)
  await executeMemoryAction(cwd, {
    action: 'add',
    title: `异步图片生成已排队: ${prompt.slice(0, 32)}`,
    body: `用户请求异步生成图片，任务已排队。任务 ID: ${id}\n提示词: ${prompt}`,
    tag: 'fact',
  }).catch(() => undefined)
  return { id, jobPath }
}

function validateJob(raw: unknown): SnapJob {
  if (!raw || typeof raw !== 'object') throw new Error('job 格式无效')
  const j = raw as Partial<SnapJob>
  if (j.version !== 1) throw new Error('不支持的 job version')
  if (typeof j.id !== 'string' || !j.id.trim()) throw new Error('job 缺少 id')
  if (typeof j.cwd !== 'string' || !j.cwd.trim()) throw new Error('job 缺少 cwd')
  if (typeof j.prompt !== 'string' || !j.prompt.trim()) throw new Error('job 缺少 prompt')
  if (typeof j.createdAt !== 'string' || !j.createdAt.trim()) throw new Error('job 缺少 createdAt')
  return j as SnapJob
}

function warmSuccessText(prompt: string, imagePath: string): string {
  return [
    `你刚才托我生成的图片已经完成啦。`,
    '',
    `我把它放在这里：${imagePath}`,
    '',
    `这次的画面关键词是：「${prompt.trim()}」。我有认真守着这个小任务，等图落地就第一时间放进你的邮箱了。`,
  ].join('\n')
}

function warmFailureText(prompt: string, error: string): string {
  return [
    `你刚才托我生成的图片这次没有成功。`,
    '',
    `请求是：「${prompt.trim()}」`,
    '',
    `失败原因：${error}`,
    '',
    `我已经把这次失败也记下来了，下一次可以换模型、调尺寸，或把提示词拆得更稳一点再试。`,
  ].join('\n')
}

async function polishSnapText(
  cfg: InfinitiConfig,
  fallback: string,
  context: string,
): Promise<string> {
  try {
    const out = await oneShotTextCompletion({
      config: cfg,
      maxOutTokens: 700,
      system:
        '你是 Infiniti Agent 的温柔人格文案助手。请只输出中文正文，不要标题，不要 Markdown 图片语法。语气亲近、克制、温暖，像对熟人汇报一个异步图片任务。把用户收件处称为“你的邮箱”。保留必要的路径、任务状态和失败原因，不要编造结果。',
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

export async function runSnapPhotoJob(jobPath: string): Promise<void> {
  const raw = JSON.parse(await readFile(jobPath, 'utf8')) as unknown
  const job = validateJob(raw)
  await appendJobLog(job.cwd, `start id=${job.id} file=${basename(jobPath)}`)
  try {
    const cfg = await loadConfig(job.cwd)
    const result = await generateSnapPhoto(job.cwd, cfg, job.prompt, job.userVision)
    const fallbackBody = warmSuccessText(job.prompt, result.path)
    const polishedBody = await polishSnapText(
      cfg,
      fallbackBody,
      [
        `状态：图片生成成功`,
        `用户提示词：${job.prompt}`,
        `图片路径：${result.path}`,
        `provider=${result.provider}, model=${result.model}, bytes=${result.bytes}`,
        fallbackBody,
      ].join('\n'),
    )
    await writeInboxMessage(job.cwd, {
      id: `${job.id}_ok`,
      subject: '图片生成完成',
      body: polishedBody,
      attachments: [{ kind: 'image', path: result.path, label: 'generated image' }],
      meta: {
        kind: 'snap',
        status: 'ok',
        jobId: job.id,
        provider: result.provider,
        model: result.model,
        bytes: result.bytes,
        usedUserPhoto: result.usedUserPhoto,
        usedAgentReference: result.usedAgentReference,
      },
    })
    await executeMemoryAction(job.cwd, {
      action: 'add',
      title: `异步图片生成完成: ${job.prompt.slice(0, 32)}`,
      body:
        `用户请求异步生成图片。提示词: ${job.prompt}\n` +
        `结果路径: ${result.path}\n` +
        `provider=${result.provider}, model=${result.model}, bytes=${result.bytes}, ` +
        `usedUserPhoto=${result.usedUserPhoto}, usedAgentReference=${result.usedAgentReference}`,
      tag: 'fact',
    }).catch(() => undefined)
    await appendAssistantSessionMessage(
      job.cwd,
      [
        `刚才的图片已经生成好了，我把邮件和图片放进了你的邮箱。`,
        '',
        polishedBody,
      ].join('\n'),
    ).catch(() => undefined)
    await appendJobLog(job.cwd, `ok id=${job.id} path=${result.path}`)
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e)
    const cfg = await loadConfig(job.cwd).catch(() => null)
    const fallbackBody = warmFailureText(job.prompt, error)
    const polishedBody = cfg
      ? await polishSnapText(
        cfg,
        fallbackBody,
        [
          `状态：图片生成失败`,
          `用户提示词：${job.prompt}`,
          `失败原因：${error}`,
          fallbackBody,
        ].join('\n'),
      )
      : fallbackBody
    await writeInboxMessage(job.cwd, {
      id: `${job.id}_failed`,
      subject: '图片生成失败',
      body: polishedBody,
      meta: { kind: 'snap', status: 'failed', jobId: job.id, error },
    }).catch(() => undefined)
    await executeMemoryAction(job.cwd, {
      action: 'add',
      title: `异步图片生成失败: ${job.prompt.slice(0, 32)}`,
      body: `用户请求异步生成图片失败。提示词: ${job.prompt}\n失败原因: ${error}`,
      tag: 'lesson',
    }).catch(() => undefined)
    await appendAssistantSessionMessage(
      job.cwd,
      [
        `刚才的图片任务没有成功，我把失败邮件放进了你的邮箱。`,
        '',
        polishedBody,
      ].join('\n'),
    ).catch(() => undefined)
    await appendJobLog(job.cwd, `failed id=${job.id} error=${error}`)
    throw e
  }
}
