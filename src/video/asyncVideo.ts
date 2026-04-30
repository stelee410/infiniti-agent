import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { InfinitiConfig } from '../config/types.js'
import type { LiveUiFileAttachment, LiveUiVisionAttachment } from '../liveui/protocol.js'
import { loadConfig } from '../config/io.js'
import { localJobsDir } from '../paths.js'
import { executeMemoryAction } from '../memory/structured.js'
import { writeInboxMessage } from '../inbox/store.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import { appendAssistantSessionMessage, appendAsyncJobLog, asyncJobFileName, currentCliWorkerInvocation } from '../jobs/asyncJob.js'
import { generateSeedanceVideo, type SeedanceReferenceImage } from './generateSeedanceVideo.js'

export type VideoJob = {
  version: 1
  id: string
  cwd: string
  prompt: string
  createdAt: string
  referenceImages?: SeedanceReferenceImage[]
}

export type EnqueuedVideoJob = {
  id: string
  jobPath: string
}

async function appendJobLog(cwd: string, line: string): Promise<void> {
  return appendAsyncJobLog(cwd, 'video-async.log', line)
}

export async function enqueueSeedanceVideoJob(
  cwd: string,
  _config: InfinitiConfig,
  prompt: string,
  referenceImages: SeedanceReferenceImage[] = [],
): Promise<EnqueuedVideoJob> {
  const id = `video_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`
  const dir = localJobsDir(cwd)
  await mkdir(dir, { recursive: true })
  const job: VideoJob = {
    version: 1,
    id,
    cwd,
    prompt,
    createdAt: new Date().toISOString(),
    ...(referenceImages.length ? { referenceImages } : {}),
  }
  const jobPath = join(dir, asyncJobFileName(id))
  await writeFile(jobPath, JSON.stringify(job, null, 2) + '\n', 'utf8')

  const childSpec = currentCliWorkerInvocation(cwd, 'video-worker', jobPath)
  const child = spawn(childSpec.command, childSpec.args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  await appendJobLog(cwd, `enqueued id=${id} job=${jobPath} imageRefs=${referenceImages.length} pid=${child.pid ?? 'unknown'}`)
  await executeMemoryAction(cwd, {
    action: 'add',
    title: `异步视频生成已排队: ${prompt.slice(0, 32)}`,
    body: `用户请求异步生成 Seedance 视频，任务已排队。任务 ID: ${id}\n提示词: ${prompt}`,
    tag: 'fact',
  }).catch(() => undefined)
  return { id, jobPath }
}

function validateJob(raw: unknown): VideoJob {
  if (!raw || typeof raw !== 'object') throw new Error('job 格式无效')
  const j = raw as Partial<VideoJob>
  if (j.version !== 1) throw new Error('不支持的 job version')
  if (typeof j.id !== 'string' || !j.id.trim()) throw new Error('job 缺少 id')
  if (typeof j.cwd !== 'string' || !j.cwd.trim()) throw new Error('job 缺少 cwd')
  if (typeof j.prompt !== 'string' || !j.prompt.trim()) throw new Error('job 缺少 prompt')
  if (typeof j.createdAt !== 'string' || !j.createdAt.trim()) throw new Error('job 缺少 createdAt')
  return j as VideoJob
}

export function seedanceReferenceImagesFromLiveInputs(
  vision?: LiveUiVisionAttachment,
  attachments: LiveUiFileAttachment[] = [],
): SeedanceReferenceImage[] {
  const out: SeedanceReferenceImage[] = []
  if (vision) {
    out.push({
      mediaType: vision.mediaType,
      base64: vision.imageBase64,
      label: 'camera snapshot',
    })
  }
  for (const a of attachments) {
    if (
      a.kind !== 'image' ||
      (a.mediaType !== 'image/jpeg' && a.mediaType !== 'image/png' && a.mediaType !== 'image/webp')
    ) {
      continue
    }
    out.push({
      mediaType: a.mediaType,
      base64: a.base64,
      label: a.name,
    })
  }
  return out.slice(0, 9)
}

function warmSuccessText(prompt: string, videoPath: string): string {
  return [
    `你刚才托我生成的视频已经完成啦。`,
    '',
    `我把视频放在这里：${videoPath}`,
    '',
    `这次的视频提示词是：「${prompt.trim()}」。生成完成后我已经把结果下载到本地，放进你的邮箱了。`,
  ].join('\n')
}

function warmFailureText(prompt: string, error: string): string {
  return [
    `你刚才托我生成的视频这次没有成功。`,
    '',
    `请求是：「${prompt.trim()}」`,
    '',
    `失败原因：${error}`,
    '',
    `我已经把这次失败也记下来了。下一次可以换模型、缩短时长，或把提示词拆得更清楚再试。`,
  ].join('\n')
}

async function polishVideoText(
  cfg: InfinitiConfig,
  fallback: string,
  context: string,
): Promise<string> {
  try {
    const out = await oneShotTextCompletion({
      config: cfg,
      maxOutTokens: 700,
      system:
        '你是 Infiniti Agent 的温柔人格文案助手。请只输出中文正文，不要标题，不要 Markdown 视频语法。语气亲近、克制、温暖，像对熟人汇报一个异步视频任务。把用户收件处称为“你的邮箱”。保留必要的路径、任务状态和失败原因，不要编造结果。',
      user: `请润色下面这段邮箱/对话通知，意思不能变：\n\n${context}`,
    })
    return out.trim() || fallback
  } catch {
    return fallback
  }
}

export async function runSeedanceVideoJob(jobPath: string): Promise<void> {
  const raw = JSON.parse(await readFile(jobPath, 'utf8')) as unknown
  const job = validateJob(raw)
  await appendJobLog(job.cwd, `start id=${job.id} file=${basename(jobPath)}`)
  try {
    const cfg = await loadConfig(job.cwd)
    const result = await generateSeedanceVideo(job.cwd, cfg, job.prompt, job.referenceImages ?? [])
    const fallbackBody = warmSuccessText(job.prompt, result.path)
    const polishedBody = await polishVideoText(
      cfg,
      fallbackBody,
      [
        `状态：视频生成成功`,
        `用户提示词：${job.prompt}`,
        `视频路径：${result.path}`,
        `provider=${result.provider}, model=${result.model}, taskId=${result.taskId}, bytes=${result.bytes}, imageRefs=${job.referenceImages?.length ?? 0}`,
        fallbackBody,
      ].join('\n'),
    )
    await writeInboxMessage(job.cwd, {
      id: `${job.id}_ok`,
      subject: '视频生成完成',
      body: polishedBody,
      attachments: [{ kind: 'file', path: result.path, label: 'generated video', mimeType: 'video/mp4' }],
      meta: {
        kind: 'video',
        provider: 'seedance',
        status: 'ok',
        jobId: job.id,
        taskId: result.taskId,
        model: result.model,
        bytes: result.bytes,
        imageRefs: job.referenceImages?.length ?? 0,
        ratio: result.ratio,
        duration: result.duration,
        resolution: result.resolution,
      },
    })
    await executeMemoryAction(job.cwd, {
      action: 'add',
      title: `异步视频生成完成: ${job.prompt.slice(0, 32)}`,
      body:
        `用户请求异步生成 Seedance 视频。提示词: ${job.prompt}\n` +
        `结果路径: ${result.path}\n` +
        `provider=${result.provider}, model=${result.model}, taskId=${result.taskId}, bytes=${result.bytes}, imageRefs=${job.referenceImages?.length ?? 0}`,
      tag: 'fact',
    }).catch(() => undefined)
    await appendAssistantSessionMessage(
      job.cwd,
      [
        `刚才的视频已经生成好了，我把邮件和视频放进了你的邮箱。`,
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
      ? await polishVideoText(
        cfg,
        fallbackBody,
        [
          `状态：视频生成失败`,
          `用户提示词：${job.prompt}`,
          `失败原因：${error}`,
          fallbackBody,
        ].join('\n'),
      )
      : fallbackBody
    await writeInboxMessage(job.cwd, {
      id: `${job.id}_failed`,
      subject: '视频生成失败',
      body: polishedBody,
      meta: { kind: 'video', provider: 'seedance', status: 'failed', jobId: job.id, error },
    }).catch(() => undefined)
    await executeMemoryAction(job.cwd, {
      action: 'add',
      title: `异步视频生成失败: ${job.prompt.slice(0, 32)}`,
      body: `用户请求异步生成 Seedance 视频失败。提示词: ${job.prompt}\n失败原因: ${error}`,
      tag: 'lesson',
    }).catch(() => undefined)
    await appendAssistantSessionMessage(
      job.cwd,
      [
        `刚才的视频任务没有成功，我把失败邮件放进了你的邮箱。`,
        '',
        polishedBody,
      ].join('\n'),
    ).catch(() => undefined)
    await appendJobLog(job.cwd, `failed id=${job.id} error=${error}`)
    throw e
  }
}
