import {
  Application,
  Mesh,
  MeshGeometry,
  MeshMaterial,
  Texture,
  Container,
} from 'pixi.js'
import { buildFaceMeshGrid, applyParallaxOffsets } from '@agent/real2d/meshGrid'
import { createIdleness } from '@agent/real2d/idleness'
import type { Real2dStatePayload } from '@agent/real2d/protocol'

/** 与 LiveUI 情绪名对齐；具体用哪张 PNG 可按美术调整 */
import texCalmUrl from '../../live2d-models/luna/expression/exp_01.png?url'
import texHappyUrl from '../../live2d-models/luna/expression/exp_02.png?url'
import texShyUrl from '../../live2d-models/luna/expression/exp_03.png?url'
/** 口型叠层：按音素换不同 PNG，避免整脸叠一张与底图嘴形几乎相同导致「层开了但看不出」 */
import mouthClosedUrl from '../../live2d-models/luna/expression/exp_06.png?url'
import mouthOpenWideUrl from '../../live2d-models/luna/expression/exp_04.png?url'
import mouthRoundUrl from '../../live2d-models/luna/expression/exp_05.png?url'
import mouthSmileUrl from '../../live2d-models/luna/expression/exp_02.png?url'

type Mood = 'happy' | 'shy' | 'calm'

/** 轮换顺序；首帧为 calm，与 moodIdx=0、初始底图一致 */
const MOOD_ORDER: Mood[] = ['calm', 'happy', 'shy']

const MOOD_LABEL: Record<Mood, string> = {
  happy: '开心 happy',
  shy: '害羞 shy',
  calm: '平静 calm',
}

const meshW = 420
const meshH = 420

/**
 * 口型叠层是整张脸 PNG，若用连续 alpha 渐变，眉/眼会「叠影」成两条眉。
 * 用滞回把显示压成近似 0/1 硬切，避免中间灰度叠两张脸。
 */
function createMouthLayerGate(): (raw: number) => 0 | 1 {
  let on = false
  return (raw: number): 0 | 1 => {
    const x = Math.min(1, Math.max(0, raw))
    if (x > 0.62) on = true
    else if (x < 0.36) on = false
    return on ? 1 : 0
  }
}

function quantize(n: number, step: number): number {
  if (step <= 0) return n
  return Math.round(n / step) * step
}

function waitTexture(t: Texture): Promise<void> {
  if (t.baseTexture.valid) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('纹理加载超时')), 20000)
    t.baseTexture.once('loaded', () => {
      clearTimeout(to)
      resolve()
    })
    t.baseTexture.once('error', (e) => {
      clearTimeout(to)
      reject(e)
    })
  })
}

function buildPositionsUvIndex(): {
  positions: Float32Array
  uvs: Float32Array
  indices: Uint16Array
  topo: ReturnType<typeof buildFaceMeshGrid>
} {
  const topo = buildFaceMeshGrid()
  const n = topo.vertices.length
  const positions = new Float32Array(n * 2)
  const uvs = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const p = topo.vertices[i]!
    uvs[i * 2] = p.u
    uvs[i * 2 + 1] = p.v
  }
  const indices = new Uint16Array(topo.indices)
  return { positions, uvs, indices, topo }
}

function fillPositionsFromDrive(
  positions: Float32Array,
  topo: ReturnType<typeof buildFaceMeshGrid>,
  rotationX: number,
  _jawOpen: number,
  breathY: number,
  gazeX: number,
  gazeY: number,
): void {
  const displaced = applyParallaxOffsets(topo.vertices, rotationX, 0.1)
  for (let i = 0; i < displaced.length; i++) {
    const u = displaced[i]!.x
    const v = displaced[i]!.y
    /* 口型/jawOpen 只驱动上层贴图 mouthLayerB，不在此拉伸 v，避免表情变化时整体包围盒高度跳动 */
    positions[i * 2] = (u - 0.5) * meshW + gazeX
    /* Pixi Y 向下；贴图 v=0 为图上方 → 应对应较小 screen Y，故用 (v-0.5)*H，勿再用负号（否则会整体倒置） */
    positions[i * 2 + 1] = (v - 0.5) * meshH + breathY + gazeY
  }
}

type WsDrive = Pick<
  Real2dStatePayload,
  'rotationX' | 'jawOpen' | 'mouthLayerB' | 'breathY' | 'gazeX' | 'gazeY'
>

type MouthTexKey = 'closed' | 'wide' | 'round' | 'smile'

const MOUTH_TEX_LABEL: Record<MouthTexKey, string> = {
  closed: 'exp_06',
  wide: 'exp_04',
  round: 'exp_05',
  smile: 'exp_02',
}

/** WS 广播里的 phoneme → 叠层用哪张贴图（整脸叠层，仅嘴部差异大时更明显） */
function mouthTextureKeyForPhoneme(p: string): MouthTexKey {
  switch (p) {
    case 'A':
    case 'E':
    case 'I':
      return 'wide'
    case 'O':
    case 'U':
      return 'round'
    case 'F':
    case 'L':
      return 'smile'
    case 'M':
    case 'X':
    default:
      return 'closed'
  }
}

function main(): void {
  const hud = document.getElementById('hud')
  const wrap = document.getElementById('wrap')
  if (!hud || !wrap) return

  const params = new URLSearchParams(location.search)
  const wsParam = params.get('ws')
  const wsUrl = wsParam?.trim() || 'ws://127.0.0.1:19876'

  let wsDrive: WsDrive | null = null
  let wsState: Real2dStatePayload | null = null
  const tryWs = (): void => {
    try {
      const ws = new WebSocket(wsUrl)
      ws.onopen = () => {
        hud.textContent = `已连接 ${wsUrl}（由 Node real2d ws 驱动）\n` + hud.textContent
      }
      ws.onmessage = (ev) => {
        try {
          const j = JSON.parse(String(ev.data)) as { type?: string; data?: Real2dStatePayload }
          if (j.type === 'real2d_state' && j.data) {
            wsState = j.data
            wsDrive = {
              rotationX: j.data.rotationX,
              jawOpen: j.data.jawOpen,
              mouthLayerB: j.data.mouthLayerB,
              breathY: j.data.breathY,
              gazeX: j.data.gazeX,
              gazeY: j.data.gazeY,
            }
          }
        } catch {
          /* ignore */
        }
      }
      ws.onerror = () => {
        wsDrive = null
        wsState = null
      }
    } catch {
      wsDrive = null
      wsState = null
    }
  }
  tryWs()

  const app = new Application({
    width: 720,
    height: 720,
    backgroundColor: 0x1a1d24,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  })
  wrap.appendChild(app.view as HTMLCanvasElement)

  const root = new Container()
  root.position.set(app.screen.width / 2, app.screen.height / 2)
  app.stage.addChild(root)

  const { positions, uvs, indices, topo } = buildPositionsUvIndex()
  const geom = new MeshGeometry(positions, uvs, indices)

  const moodTextures: Record<Mood, Texture> = {
    calm: Texture.from(texCalmUrl),
    happy: Texture.from(texHappyUrl),
    shy: Texture.from(texShyUrl),
  }
  const mouthTextures: Record<MouthTexKey, Texture> = {
    closed: Texture.from(mouthClosedUrl),
    wide: Texture.from(mouthOpenWideUrl),
    round: Texture.from(mouthRoundUrl),
    smile: Texture.from(mouthSmileUrl),
  }

  let moodIdx = 0
  let demoElapsed = 0
  const demoSwitchMs = 1800

  const idle = createIdleness()
  let simT = 0

  void (async () => {
    try {
      await Promise.all([
        waitTexture(moodTextures.happy),
        waitTexture(moodTextures.shy),
        waitTexture(moodTextures.calm),
        ...Object.values(mouthTextures).map((t) => waitTexture(t)),
      ])
    } catch (e) {
      hud.textContent = `无法加载 Luna PNG：${(e as Error).message}\n请确认路径 live2d-models/luna/expression 存在。`
      return
    }

    const matFace = new MeshMaterial(moodTextures.calm)
    const matMouth = new MeshMaterial(mouthTextures.closed)
    const meshFace = new Mesh(geom, matFace)
    const meshMouth = new Mesh(geom, matMouth)
    meshMouth.alpha = 0
    meshMouth.zIndex = 1
    root.sortableChildren = true
    root.addChild(meshFace)
    root.addChild(meshMouth)

    const mouthGate = createMouthLayerGate()

    app.ticker.add(() => {
      const dtMs = app.ticker.deltaMS
      simT += dtMs / 1000

      let rotationX: number
      let jawOpen: number
      let mouthLayerB: number
      let breathY: number
      let gazeX: number
      let gazeY: number

      if (wsDrive) {
        rotationX = wsDrive.rotationX
        jawOpen = wsDrive.jawOpen
        mouthLayerB = wsDrive.mouthLayerB
        breathY = wsDrive.breathY
        gazeX = wsDrive.gazeX
        gazeY = wsDrive.gazeY
      } else {
        rotationX = Math.sin(simT * 0.9) * 0.14
        demoElapsed += dtMs
        if (demoElapsed >= demoSwitchMs) {
          demoElapsed = 0
          moodIdx = (moodIdx + 1) % MOOD_ORDER.length
          const m = MOOD_ORDER[moodIdx]!
          matFace.texture = moodTextures[m]
        }
        const id = idle.tick(dtMs)
        jawOpen = 0
        mouthLayerB = 0
        breathY = id.breathY
        gazeX = id.gazeX * 0.35
        gazeY = id.gazeY * 0.25
      }

      /* 略「顿」一点：转头、呼吸、眼神按阶梯走，避免像抹了油一样顺 */
      rotationX = quantize(rotationX, 0.038)
      breathY = quantize(breathY, 0.65)
      gazeX = quantize(gazeX, 0.8)
      gazeY = quantize(gazeY, 0.55)

      fillPositionsFromDrive(positions, topo, rotationX, jawOpen, breathY, gazeX, gazeY)
      geom.getBuffer('aVertexPosition').update()

      /* 本地演示：整脸换图表现 happy/shy/calm，不开口型叠层，避免与表情切换打架 */
      const mouthOn = Boolean(wsDrive && mouthGate(mouthLayerB))
      meshMouth.alpha = mouthOn ? 1 : 0
      if (mouthOn && wsState) {
        const key = mouthTextureKeyForPhoneme(wsState.phoneme)
        const nextTex = mouthTextures[key]
        if (matMouth.texture !== nextTex) {
          matMouth.texture = nextTex
        }
      }

      const mode = wsDrive ? 'WS' : '本地演示'
      const mouthKey = wsState ? mouthTextureKeyForPhoneme(wsState.phoneme) : 'closed'
      const mouthFile = MOUTH_TEX_LABEL[mouthKey]
      const moodLine = wsDrive
        ? `phoneme=${wsState?.phoneme ?? '—'} · 口型贴=${mouthFile}${mouthOn ? '' : '（层关）'}`
        : `表情=${MOOD_LABEL[MOOD_ORDER[moodIdx]!]}`
      hud.textContent =
        `${mode} · 15×15 Mesh · ${wsDrive ? '口型层滞回+按音素换贴图' : 'happy / shy / calm 轮换'}\n` +
        `rotationX=${rotationX.toFixed(3)} jawOpen=${jawOpen.toFixed(2)} mouth层=${mouthOn ? '开' : '关'}\n` +
        `${moodLine} · breathY=${breathY.toFixed(2)}\n` +
        `可选：另开终端 npx tsx src/cli.tsx real2d ws 后刷新（默认已连 ws://127.0.0.1:19876）`
    })
  })()
}

main()
