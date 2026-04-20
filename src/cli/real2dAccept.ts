import { Command } from 'commander'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import WebSocket from 'ws'
import sharp from 'sharp'
import { assertLunaAssetsPresent, LUNA_EXPRESSION_DIR } from '../real2d/lunaAssets.js'
import { buildFaceMeshGrid, MESH_DIM, applyParallaxOffsets } from '../real2d/meshGrid.js'
import { parseEmotionIntensityFromText } from '../real2d/emotionIntensity.js'
import { PhonemeStateMachine, type Real2dPhoneme } from '../real2d/phonemeState.js'
import { createIdleness } from '../real2d/idleness.js'
import { Real2dWsBridge } from '../real2d/wsBridge.js'
import { PACKAGE_ROOT } from '../packageRoot.js'

function parsePort(s: string | undefined, fallback: number): number {
  const n = Number(s)
  if (!Number.isFinite(n) || n < 1 || n > 65535) return fallback
  return Math.floor(n)
}

async function runCheck(): Promise<number> {
  const r = assertLunaAssetsPresent()
  console.log(`Luna 目录: ${r.dir}`)
  if (!r.ok) {
    console.error(`✗ ${r.error ?? '验收失败'}`)
    return 2
  }
  console.log(`✓ 找到 ${r.files.length} 个表情: ${r.files.join(', ')}`)

  const topo = buildFaceMeshGrid()
  console.log(`✓ 网格拓扑: ${topo.vertices.length} 顶点 (${MESH_DIM}×${MESH_DIM})，${topo.indices.length / 3} 三角形`)

  const first = join(LUNA_EXPRESSION_DIR, r.files[0]!)
  let w = 0
  let h = 0
  try {
    const m = await sharp(first).metadata()
    w = m.width ?? 0
    h = m.height ?? 0
    console.log(`✓ 参考尺寸 ${r.files[0]}: ${w}×${h}`)
  } catch (e) {
    console.error(`✗ 无法读取 PNG: ${(e as Error).message}`)
    return 2
  }

  for (const f of r.files) {
    const p = join(LUNA_EXPRESSION_DIR, f)
    try {
      const m = await sharp(p).metadata()
      const mw = m.width ?? 0
      const mh = m.height ?? 0
      if (mw !== w || mh !== h) {
        console.error(`✗ 尺寸不一致: ${f} 为 ${mw}×${mh}，期望 ${w}×${h}`)
        return 2
      }
    } catch (e) {
      console.error(`✗ ${f}: ${(e as Error).message}`)
      return 2
    }
  }
  console.log('✓ 全部 PNG 尺寸一致')

  const sampleText = '你好 [Smile] 今天 [Happy] 真不错'
  const em = parseEmotionIntensityFromText(sampleText)
  console.log(`✓ 情绪解析样例: tags=${JSON.stringify(em.tags)} maxIntensity=${em.maxIntensity}`)

  const mesh = buildFaceMeshGrid()
  const d0 = applyParallaxOffsets(mesh.vertices, 0.2, 0.08)
  const d1 = applyParallaxOffsets(mesh.vertices, 0.2, 0.08)
  const idxN = 6 * MESH_DIM + 7
  const idxC = 0
  const nMag = Math.abs(d0[idxN]!.x - mesh.vertices[idxN]!.x)
  const cMag = Math.abs(d0[idxC]!.x - mesh.vertices[idxC]!.x)
  if (!(nMag > cMag)) {
    console.error(`✗ Parallax 验收失败: 鼻区位移 ${nMag} 应大于角点 ${cMag}`)
    return 2
  }
  console.log(`✓ Parallax: 鼻区 |dx|=${nMag.toFixed(5)} > 角点 |dx|=${cMag.toFixed(5)}`)
  void d1

  return 0
}

/**  stdout 一行 JSON：无端口、供脚本化断言 */
async function runSimulate(): Promise<number> {
  const ph = new PhonemeStateMachine()
  ph.setPhoneme('M')
  ph.tick(0)
  ph.setPhoneme('A')
  ph.tick(60)
  const idle = createIdleness()
  const id = idle.tick(100)
  const mesh = buildFaceMeshGrid()
  const disp = applyParallaxOffsets(mesh.vertices, 0.12, 0.08)
  const out = {
    jawOpenAfterMA: ph.getDrive().jawOpen,
    mouthLayerB: ph.getDrive().mouthLayerB,
    idle: id,
    noseDx: disp[6 * MESH_DIM + 7]!.x - mesh.vertices[6 * MESH_DIM + 7]!.x,
  }
  console.log(JSON.stringify(out))
  return 0
}

async function runWs(port: number, tickHz: number, face: string | undefined): Promise<number> {
  const assets = assertLunaAssetsPresent()
  if (!assets.ok) {
    console.error(assets.error)
    return 2
  }
  const faceTexture = face && assets.files.includes(face) ? face : assets.files[0]!
  const bridge = new Real2dWsBridge({ port, faceTexture, tickHz })
  await bridge.start()
  console.log(`[real2d] WebSocket ws://127.0.0.1:${port} 已监听（tick ${tickHz} Hz）`)
  console.log(`[real2d] 发送 JSON: {"type":"real2d_drive","rotationX":0.1,"phoneme":"A","emotionIntensity":0.5}`)
  console.log('[real2d] Ctrl+C 结束')
  await new Promise<void>(() => {})
  return 0
}

async function runPingClient(port: number): Promise<number> {
  const url = `ws://127.0.0.1:${port}`
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', (e) => reject(e))
  })
  ws.send(JSON.stringify({ type: 'real2d_ping', nonce: 'accept' }))
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('accept_ws: 等待 pong 超时')), 4000)
    const onMsg = (d: WebSocket.RawData): void => {
      try {
        const j = JSON.parse(String(d)) as { type?: string }
        if (j.type === 'real2d_pong') {
          clearTimeout(t)
          ws.off('message', onMsg)
          resolve()
        }
      } catch {
        /* 忽略非 JSON */
      }
    }
    ws.on('message', onMsg)
  })
  ws.close()
  console.log('✓ WebSocket 握手与 ping/pong 正常')
  return 0
}

async function runPreview(): Promise<number> {
  const dir = join(PACKAGE_ROOT, 'real2d-preview')
  if (!existsSync(join(dir, 'package.json'))) {
    console.error(`未找到 real2d-preview: ${dir}`)
    return 2
  }
  console.error('[real2d] 启动 Vite 预览… 浏览器打开: http://127.0.0.1:5179')
  console.error('[real2d] 可选：另开终端执行 npx tsx src/cli.tsx real2d ws，用 Node 侧状态驱动画面')
  console.error('[real2d] Ctrl+C 结束')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', 'dev'], {
      cwd: dir,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('error', reject)
    child.on('close', () => {
      resolve()
    })
  })
  return 0
}

/** 口型联调：与预览默认 WS 端口一致 */
const DRIVE_DEMO_PHONEMES: Real2dPhoneme[] = ['M', 'A', 'O', 'E', 'I', 'U', 'M']

async function runDriveDemo(port: number, intervalMs: number): Promise<number> {
  const url = `ws://127.0.0.1:${port}`
  const ws = new WebSocket(url)
  try {
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('连接超时：请先另开终端执行 npx tsx src/cli.tsx real2d ws')), 6000)
      ws.once('open', () => {
        clearTimeout(to)
        resolve()
      })
      ws.once('error', (e) => {
        clearTimeout(to)
        reject(e)
      })
    })
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { message?: string }
    const msg = err?.message ?? String(e)
    if (/ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
      console.error(`无法连接 ${url}（${msg}）`)
      console.error('')
      console.error('须先在本仓库根目录（含 package.json、src/cli.tsx）另开终端启动桥接并保持运行：')
      console.error(`  npm run real2d:ws`)
      console.error('或')
      console.error(`  npx tsx src/cli.tsx real2d ws --port ${port}`)
      console.error('')
      console.error('然后再运行 drive_demo；浏览器预览请先开 ws 再刷新 http://127.0.0.1:5179')
    } else {
      console.error(msg)
    }
    return 2
  }

  let idx = 0
  const send = (): void => {
    const phoneme = DRIVE_DEMO_PHONEMES[idx % DRIVE_DEMO_PHONEMES.length]!
    idx++
    const rotationX = 0.06 * Math.sin(idx * 0.12)
    ws.send(JSON.stringify({ type: 'real2d_drive', rotationX, phoneme }))
  }
  send()
  const timer = setInterval(send, intervalMs)

  console.error(`[drive_demo] 已连接 ${url}`)
  console.error(
    `[drive_demo] 每 ${intervalMs}ms 发送音素循环: ${DRIVE_DEMO_PHONEMES.join(' → ')} …（Ctrl+C 结束）`,
  )
  console.error('[drive_demo] 浏览器打开 http://127.0.0.1:5179 （npm run real2d:preview）即可看口型叠层')

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      clearInterval(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

export function registerReal2dCli(program: Command): void {
  const r = program
    .command('real2d')
    .description('写实风 Hybrid Mesh（探索）：Luna 素材目录验收、状态模拟与 WS 桥')

  r.command('check')
    .description('验收 live2d-models/luna/expression 与核心算法自检')
    .action(async () => {
      process.exitCode = await runCheck()
    })

  r.command('simulate')
    .description('输出一行 JSON（M→A 后 jaw、idle、Parallax 采样），无需网络')
    .action(async () => {
      process.exitCode = await runSimulate()
    })

  r.command('ws')
    .description('启动本地 WebSocket，向已连接客户端广播 real2d_state')
    .option('--port <n>', '端口', '19876')
    .option('--tick-hz <n>', '广播频率', '30')
    .option('--face <file>', '默认 faceTexture（exp_*.png 文件名）')
    .action(async (cmd: { port?: string; tickHz?: string; face?: string }) => {
      const port = parsePort(cmd.port, 19876)
      const tickHz = Math.min(60, Math.max(10, parsePort(cmd.tickHz, 30)))
      process.exitCode = await runWs(port, tickHz, cmd.face)
    })

  r.command('drive_demo')
    .description('连接 real2d WebSocket，循环发送音素（开发口型；需先 real2d ws）')
    .option('--port <n>', '端口（与 real2d ws 一致）', '19876')
    .option('--interval <ms>', '切换音素间隔（毫秒）', '450')
    .action(async (cmd: { port?: string; interval?: string }) => {
      const port = parsePort(cmd.port, 19876)
      const raw = cmd.interval?.trim() ? Number(cmd.interval) : 450
      const intervalMs = Math.max(80, Number.isFinite(raw) ? Math.floor(raw) : 450)
      process.exitCode = await runDriveDemo(port, intervalMs)
    })

  r.command('preview')
    .description('浏览器内 Pixi 预览（15×15 Mesh + Luna 双层口型示意，http://127.0.0.1:5179）')
    .action(async () => {
      try {
        process.exitCode = await runPreview()
      } catch (e) {
        console.error((e as Error).message)
        console.error('若提示缺少 vite，请在仓库根目录执行: npm install')
        process.exitCode = 1
      }
    })

  r.command('accept_ws')
    .description('启动 WS 并完成 ping/pong 后退出（用于自动化验收）')
    .option('--port <n>', '端口（默认在 accept_ws 内动态选取）', '')
    .action(async (cmd: { port?: string }) => {
      const base = cmd.port?.trim() ? parsePort(cmd.port, 19876) : 30200 + Math.floor(Math.random() * 2000)
      const bridge = new Real2dWsBridge({ port: base, tickHz: 30 })
      await bridge.start()
      try {
        process.exitCode = await runPingClient(base)
      } finally {
        await bridge.dispose()
      }
    })
}
