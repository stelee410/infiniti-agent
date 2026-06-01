import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { LiveUiVisionAttachment } from '../liveui/protocol.js'
import { screenshotsDir } from '../paths.js'

const exec = promisify(execFile)

/** Anthropic 等多模态模型推荐的长边上限；超过会被它们重采样，提前缩小可省 token。 */
const MAX_DIM = 1568

export type ScreenshotResult =
  | { ok: true; vision: LiveUiVisionAttachment; path: string; bytes: number }
  | { ok: false; error: string }

/**
 * 截取主显示器整屏，缩放到长边 ≤1568，保存到 workspace/screenshots/ 并返回可直接
 * 喂给多模态 LLM 的视觉附件（image/jpeg）。仅 macOS（依赖 screencapture / sips）。
 *
 * 注意：macOS 需对承载进程授予「屏幕录制」权限；未授权时 screencapture 通常不会报错，
 * 而是截到黑屏——这点无法在此处可靠探测，只能在结果异常时由用户排查权限。
 */
export async function captureMainScreenVision(cwd: string): Promise<ScreenshotResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: '截屏目前仅支持 macOS（依赖 screencapture）' }
  }
  const dir = screenshotsDir(cwd)
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const path = join(dir, `${stamp}.jpg`)

  try {
    // -x 不发声 · -m 只截主显示器 · -t jpg 输出 jpeg
    await exec('screencapture', ['-x', '-m', '-t', 'jpg', path])
  } catch (e) {
    return { ok: false, error: `screencapture 失败（可能未授予「屏幕录制」权限）：${(e as Error).message}` }
  }

  // 缩放到长边 ≤1568；失败不致命，退回原图。
  try {
    await exec('sips', ['-Z', String(MAX_DIM), path])
  } catch {
    /* keep original size */
  }

  try {
    const buf = await readFile(path)
    if (buf.length === 0) {
      return { ok: false, error: '截图为空，请检查「屏幕录制」权限' }
    }
    return {
      ok: true,
      path,
      bytes: buf.length,
      vision: {
        imageBase64: buf.toString('base64'),
        mediaType: 'image/jpeg',
        capturedAt: new Date().toISOString(),
      },
    }
  } catch (e) {
    return { ok: false, error: `读取截图失败：${(e as Error).message}` }
  }
}
