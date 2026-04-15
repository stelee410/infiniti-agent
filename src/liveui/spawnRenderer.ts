import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../packageRoot.js'

/**
 * 启动 Electron 渲染进程（liveui 包）。需已安装 electron（工作区 liveui 或根依赖）。
 */
export function spawnLiveElectron(port: number, model3FileUrl?: string): ChildProcess | null {
  const main = join(PACKAGE_ROOT, 'liveui', 'electron-main.cjs')
  if (!existsSync(main)) {
    console.error(`[liveui] 未找到 Electron 入口: ${main}`)
    return null
  }

  let electronCli: string
  try {
    const require = createRequire(import.meta.url)
    electronCli = require.resolve('electron/cli.js', { paths: [PACKAGE_ROOT, join(PACKAGE_ROOT, 'liveui')] })
  } catch {
    console.error('[liveui] 未解析到 electron/cli.js。请在仓库根目录执行 npm install（含 liveui 工作区）。')
    return null
  }

  const child = spawn(process.execPath, [electronCli, main], {
    env: {
      ...process.env,
      INFINITI_LIVEUI_PORT: String(port),
      ...(model3FileUrl ? { INFINITI_LIVEUI_MODEL3_FILE_URL: model3FileUrl } : {}),
    },
    detached: false,
    stdio: 'ignore',
  })
  child.on('error', (e) => {
    console.error(`[liveui] Electron 启动失败: ${(e as Error).message}`)
  })
  return child
}
