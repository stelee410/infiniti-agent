import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../packageRoot.js'

export function resolveElectronCliJs(): string | null {
  const direct = [
    join(PACKAGE_ROOT, 'node_modules', 'electron', 'cli.js'),
    join(PACKAGE_ROOT, 'liveui', 'node_modules', 'electron', 'cli.js'),
  ]
  for (const p of direct) {
    if (existsSync(p)) return p
  }
  try {
    const req = createRequire(import.meta.url)
    return req.resolve('electron/cli.js', {
      paths: [PACKAGE_ROOT, join(PACKAGE_ROOT, 'liveui')],
    })
  } catch {
    return null
  }
}

export type LiveUiElectronSpawnOptions = {
  model3FileUrl?: string
  /** 含尾斜杠的 `file:` URL，指向含 `exp_01.png`…的目录 */
  spriteExpressionDirFileUrl?: string
  /** JSON：`{ speechRmsThreshold, silenceEndMs, suppressInterruptDuringTts }` */
  voiceMicJson?: string
  /**
   * 人物显示缩放系数（0.4 ~ 1.5）。仅作用于 Live2D / 精灵图本身，不影响控制条 / 输入框尺寸。
   * 通过 `INFINITI_LIVEUI_FIGURE_ZOOM` 注入渲染进程，由 `figureLayoutConfig` 处乘到 widthFraction 上。
   */
  figureZoom?: number
}

/**
 * 启动 Electron 渲染进程（liveui 包）。需已安装 `electron`（根目录或 liveui 的 node_modules）。
 */
export function spawnLiveElectron(port: number, opts?: LiveUiElectronSpawnOptions): ChildProcess | null {
  const main = join(PACKAGE_ROOT, 'liveui', 'electron-main.cjs')
  if (!existsSync(main)) {
    console.error(`[liveui] 未找到 Electron 入口: ${main}`)
    return null
  }

  const electronCli = resolveElectronCliJs()
  if (!electronCli) {
    console.error(
      '[liveui] 未找到 electron：无法打开虚拟人窗口（仅 WebSocket 在跑）。\n' +
        `  包根: ${PACKAGE_ROOT}\n` +
        '  处理: 在 infiniti-agent 包根执行 npm install（含 workspaces）；或全局安装后再装一次本包以拉取 optional 依赖里的 electron。\n' +
        '  从源码开发: cd 仓库根目录 && npm install && npm run build',
    )
    return null
  }

  const child = spawn(process.execPath, [electronCli, main], {
    env: {
      ...process.env,
      INFINITI_LIVEUI_PORT: String(port),
      ...(opts?.model3FileUrl ? { INFINITI_LIVEUI_MODEL3_FILE_URL: opts.model3FileUrl } : {}),
      ...(opts?.spriteExpressionDirFileUrl
        ? { INFINITI_LIVEUI_SPRITE_EXPRESSION_DIR: opts.spriteExpressionDirFileUrl }
        : {}),
      ...(opts?.voiceMicJson ? { INFINITI_LIVEUI_VOICE_MIC: opts.voiceMicJson } : {}),
      ...(typeof opts?.figureZoom === 'number' && Number.isFinite(opts.figureZoom)
        ? { INFINITI_LIVEUI_FIGURE_ZOOM: String(opts.figureZoom) }
        : {}),
    },
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d: Buffer) => {
    process.stderr.write(`[liveui:electron] ${d.toString('utf8')}`)
  })
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[liveui:electron] ${d.toString('utf8')}`)
  })
  child.on('error', (e) => {
    console.error(`[liveui] Electron 启动失败: ${(e as Error).message}`)
  })
  return child
}
