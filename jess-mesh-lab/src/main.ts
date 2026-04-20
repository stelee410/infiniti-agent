import {
  Application,
  Mesh,
  MeshGeometry,
  MeshMaterial,
  Texture,
  Container,
} from 'pixi.js'
import { buildFaceMeshGrid, applyParallaxOffsets } from '@agent/real2d/meshGrid'
import {
  buildVisemeTimeline,
  sampleMouthTargets,
  sampleVowelSlot,
  totalDurationMs,
  lipShapeEnergy,
  type VisemeSeg,
  type MouthTargets,
  type VowelSlot,
} from './textToViseme'

/**
 * 兜底 bundle：直接打包透明产物 expression_web/，确保即便 public/jess/ 缺失，
 * 浏览器也只会拿到「透明版」而不是带白底的原始素材。
 * 透明产物由 `npm run jess:lab:prep` 生成。
 */
import calmBundledUrl from '../../live2d-models/jess/expression_web/exp_calm.png?url'
import speakingBundledUrl from '../../live2d-models/jess/expression_web/exp_speaking.png?url'
import vowelABundledUrl from '../../live2d-models/jess/expression_web/exp_speaking_a.png?url'
import vowelEBundledUrl from '../../live2d-models/jess/expression_web/exp_speaking_e.png?url'
import vowelIBundledUrl from '../../live2d-models/jess/expression_web/exp_speaking_i.png?url'
import vowelOBundledUrl from '../../live2d-models/jess/expression_web/exp_speaking_o.png?url'
import vowelUBundledUrl from '../../live2d-models/jess/expression_web/exp_speaking_u.png?url'

/** 按贴图原始宽高比缩放到限制框内（像素），避免正方形 Mesh 把竖图压扁 */
function meshPixelSizeForTexture(tex: Texture, maxW: number, maxH: number): { w: number; h: number } {
  const bw = tex.baseTexture.realWidth || tex.width
  const bh = tex.baseTexture.realHeight || tex.height
  if (bw <= 0 || bh <= 0) {
    return { w: maxW, h: maxH }
  }
  const s = Math.min(maxW / bw, maxH / bh)
  return { w: bw * s, h: bh * s }
}

/**
 * calm 与部分元音图分辨率不一致（如 2528×1682 vs 2506×1664）时，
 * 仍用 calm 算出的 mesh 尺寸绑贴图会整体错位/闪；按 calm 像素框对齐当前贴图。
 */
function stabilizeMeshScaleToCalm(mesh: Mesh, texCalm: Texture, active: Texture): void {
  const rw = texCalm.baseTexture.realWidth || texCalm.width
  const rh = texCalm.baseTexture.realHeight || texCalm.height
  const aw = active.baseTexture.realWidth || active.width
  const ah = active.baseTexture.realHeight || active.height
  if (rw <= 0 || rh <= 0 || aw <= 0 || ah <= 0) {
    mesh.scale.set(1, 1)
    return
  }
  if (Math.abs(aw - rw) < 0.5 && Math.abs(ah - rh) < 0.5) {
    mesh.scale.set(1, 1)
    return
  }
  mesh.scale.set(rw / aw, rh / ah)
}

/** 元音贴图相对 calm 的像素微调表（source-pixel 单位，由 jess-vowel-nudge.ts 测得） */
type VowelNudgePx = Record<'a' | 'e' | 'i' | 'o' | 'u', { dx: number; dy: number }>
const FALLBACK_VOWEL_NUDGE_PX: VowelNudgePx = {
  a: { dx: 2, dy: -1 },
  e: { dx: -27, dy: 7 },
  i: { dx: -29, dy: 5 },
  o: { dx: -28, dy: 7 },
  u: { dx: -28, dy: 7 },
}

async function loadVowelNudge(): Promise<VowelNudgePx> {
  try {
    const url = `${viteBase()}jess/vowel-nudge.json`
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) return FALLBACK_VOWEL_NUDGE_PX
    const json = (await res.json()) as { nudgePx?: Partial<VowelNudgePx> }
    if (!json?.nudgePx) return FALLBACK_VOWEL_NUDGE_PX
    return {
      a: json.nudgePx.a ?? FALLBACK_VOWEL_NUDGE_PX.a,
      e: json.nudgePx.e ?? FALLBACK_VOWEL_NUDGE_PX.e,
      i: json.nudgePx.i ?? FALLBACK_VOWEL_NUDGE_PX.i,
      o: json.nudgePx.o ?? FALLBACK_VOWEL_NUDGE_PX.o,
      u: json.nudgePx.u ?? FALLBACK_VOWEL_NUDGE_PX.u,
    }
  } catch {
    return FALLBACK_VOWEL_NUDGE_PX
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/** 用浏览器 Image 解码，避免 Texture.from(URL) 在部分环境下 baseTexture error 无 message */
function textureFromUrl(url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = (): void => {
      try {
        resolve(Texture.from(img))
      } catch (e) {
        reject(new Error(`Texture.from 失败: ${errMsg(e)}`))
      }
    }
    img.onerror = (): void => {
      reject(new Error(`图片请求失败（404 或未运行 jess:lab:prep）: ${url}`))
    }
    img.src = url
  })
}

function viteBase(): string {
  const b = import.meta.env.BASE_URL ?? '/'
  return b.endsWith('/') ? b : `${b}/`
}

/** 优先 public/jess 透明图，失败则用打包进 bundle 的原始图 */
async function loadJessPng(
  fileName: string,
  bundledUrl: string,
): Promise<{ texture: Texture; transparent: boolean }> {
  if (!bundledUrl?.trim()) {
    throw new Error(`Vite 未解析到 ${fileName}`)
  }
  const candidates: { url: string; transparent: boolean }[] = [
    { url: `${viteBase()}jess/${fileName}`, transparent: true },
    { url: bundledUrl, transparent: false },
  ]
  const errors: string[] = []
  for (const c of candidates) {
    try {
      const texture = await textureFromUrl(c.url)
      return { texture, transparent: c.transparent }
    } catch (e) {
      errors.push(`${c.url} → ${errMsg(e)}`)
    }
  }
  throw new Error(errors.join(' | '))
}

function buildGeometryBuffers(): {
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

/**
 * 下颌一带（略大、偏下）：张口时少量带动，避免整脸「大块」拉扯。
 */
function mouthChinInfluenceUv(u: number, v: number): number {
  if (v < 0.3 || v > 0.55) return 0
  if (u < 0.28 || u > 0.72) return 0
  const cx = 0.5
  const cy = 0.472
  const rx = 0.16
  const ry = 0.1
  const dx = (u - cx) / rx
  const dy = (v - cy) / ry
  const r2 = dx * dx + dy * dy
  if (r2 >= 1) return 0
  return (1 - r2) ** 1.55
}

/**
 * 嘴唇局部（小椭圆、偏上）：同一张口度下这里权重大，微笑/嘴角变化更明显。
 */
function mouthLipInfluenceUv(u: number, v: number): number {
  if (v < 0.378 || v > 0.498) return 0
  if (u < 0.34 || u > 0.66) return 0
  const cx = 0.5
  const cy = 0.428
  const rx = 0.1
  const ry = 0.048
  const dx = (u - cx) / rx
  const dy = (v - cy) / ry
  const r2 = dx * dx + dy * dy
  if (r2 >= 1) return 0
  return (1 - r2) ** 2.35
}

type FillMeshOpts = {
  parallaxAmp?: number
  jawGamma?: number
  /** -1…1，叠加在 spread 上的细微表情 */
  lipSmile?: number
  /** 时间轴 viseme：贴图替换为主时压到 <1，只留轻微「不确定」形变 */
  mouthShape?: MouthTargets
  /** 对 spread/pucker/narrow 的缩放（默认 1） */
  visemeMeshScale?: number
}

/** Parallax + 口周 mesh 张口；w/h 与贴图物理比例一致 */
function fillMeshPositions(
  positions: Float32Array,
  topo: ReturnType<typeof buildFaceMeshGrid>,
  rotationX: number,
  openness: number,
  meshW: number,
  meshH: number,
  jawGain: number,
  opts?: FillMeshOpts,
): void {
  const parallaxAmp = opts?.parallaxAmp ?? 0.055
  const jawGamma = opts?.jawGamma ?? 1.35
  const displaced = applyParallaxOffsets(topo.vertices, rotationX, parallaxAmp)
  const lipSmile = opts?.lipSmile ?? 0
  const ms = opts?.mouthShape
  const shapeK = opts?.visemeMeshScale ?? 1
  for (let i = 0; i < displaced.length; i++) {
    let u = displaced[i]!.x
    let v = displaced[i]!.y
    const chinW = mouthChinInfluenceUv(u, v)
    const lipW = mouthLipInfluenceUv(u, v)
    const mouthBlend = chinW * 0.3 + lipW * 1.15
    const jaw = Math.pow(Math.min(1, Math.max(0, openness)), jawGamma) * jawGain
    v += jaw * mouthBlend
    if (lipW > 0.004 && ms) {
      const sp = ms.spread * shapeK
      const pk = ms.pucker * shapeK
      const nw = ms.narrow * shapeK
      u += (u - 0.5) * lipW * (sp * 0.28 + Math.max(0, lipSmile) * 0.09)
      u += (0.5 - u) * lipW * (nw * 0.3 + pk * 0.2)
      v -= lipW * nw * 0.045
      v += lipW * pk * 0.05
    } else if (lipSmile !== 0 && lipW > 0.004) {
      u += lipSmile * (u - 0.5) * lipW * 0.12
    }
    positions[i * 2] = (u - 0.5) * meshW
    positions[i * 2 + 1] = (v - 0.5) * meshH
  }
}

function main(): void {
  const wrap = document.getElementById('canvas-wrap')
  const ta = document.getElementById('speech') as HTMLTextAreaElement | null
  const btnPlay = document.getElementById('play') as HTMLButtonElement | null
  const btnStop = document.getElementById('stop') as HTMLButtonElement | null
  const status = document.getElementById('status')
  if (!wrap || !ta || !btnPlay || !btnStop || !status) return

  let timeline: VisemeSeg[] = []
  let playStart = 0
  let playing = false
  let totalMs = 0
  let subtleT = 0

  const app = new Application({
    width: 720,
    height: 680,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  })
  wrap.appendChild(app.view as HTMLCanvasElement)

  const root = new Container()
  app.stage.addChild(root)

  const { positions, uvs, indices, topo } = buildGeometryBuffers()
  const geom = new MeshGeometry(positions, uvs, indices)

  void (async () => {
    let texCalm: Texture
    let texSpeaking: Texture
    let usedTransparent = false
    try {
      const calm = await loadJessPng('exp_calm.png', calmBundledUrl as string)
      texCalm = calm.texture
      usedTransparent = calm.transparent
    } catch (e) {
      status.textContent = `加载 exp_calm 失败: ${errMsg(e)}`
      return
    }
    try {
      const sp = await loadJessPng('exp_speaking.png', speakingBundledUrl as string)
      texSpeaking = sp.texture
    } catch {
      texSpeaking = texCalm
    }

    const vowelBundles: Record<VowelSlot, string> = {
      a: vowelABundledUrl as string,
      e: vowelEBundledUrl as string,
      i: vowelIBundledUrl as string,
      o: vowelOBundledUrl as string,
      u: vowelUBundledUrl as string,
    }
    const texVowel = {} as Record<VowelSlot, Texture>
    const vowelOrder: VowelSlot[] = ['a', 'e', 'i', 'o', 'u']
    for (const slot of vowelOrder) {
      try {
        const v = await loadJessPng(`exp_speaking_${slot}.png`, vowelBundles[slot])
        texVowel[slot] = v.texture
      } catch {
        texVowel[slot] = texSpeaking
      }
    }

    const { w: meshW, h: meshH } = meshPixelSizeForTexture(texCalm, 620, 620)
    const cx = Math.round(app.screen.width / 2)
    const cy = Math.round(app.screen.height / 2)
    root.position.set(cx, cy)
    root.roundPixels = true

    const mat = new MeshMaterial(texCalm)
    const mesh = new Mesh(geom, mat)
    mesh.roundPixels = true
    root.addChild(mesh)

    /** 把 source-pixel 偏移换算到屏幕像素，按 calm 的实际宽度比 */
    const calmRealW = texCalm.baseTexture.realWidth || texCalm.width || 1
    const srcToScreen = meshW / calmRealW
    const vowelNudgePx = await loadVowelNudge()
    const vowelNudgeScreen: Record<VowelSlot, { x: number; y: number }> = {
      a: { x: 0, y: 0 },
      e: { x: 0, y: 0 },
      i: { x: 0, y: 0 },
      o: { x: 0, y: 0 },
      u: { x: 0, y: 0 },
    }
    for (const slot of ['a', 'e', 'i', 'o', 'u'] as VowelSlot[]) {
      vowelNudgeScreen[slot] = {
        x: Math.round(vowelNudgePx[slot].dx * srcToScreen),
        y: Math.round(vowelNudgePx[slot].dy * srcToScreen),
      }
    }

    const srcW = texCalm.baseTexture.realWidth || texCalm.width
    const srcH = texCalm.baseTexture.realHeight || texCalm.height
    if (!usedTransparent) {
      status.textContent =
        `贴图 ${Math.round(srcW)}×${Math.round(srcH)} → 显示 ${Math.round(meshW)}×${Math.round(meshH)}（保持比例）。播放：闭嘴 exp_calm；张嘴按元音切换 exp_speaking_a/e/i/o/u，mesh 仅弱抖动。建议 npm run jess:lab:prep。`
    } else {
      status.textContent = `贴图 ${Math.round(srcW)}×${Math.round(srcH)} → 显示 ${Math.round(meshW)}×${Math.round(
        meshH,
      )}（透明）。元音贴图替换 + 弱 mesh。就绪。`
    }

    /** 静止：略动；张嘴：全脸视差/转头减弱，形变集中在嘴唇带 + lipSmile */
    const JAW_IDLE = 0.026
    const JAW_SPEAKING = 0.024
    const SPEAK_PARALLAX = 0.036
    const SPEAK_JAW_GAMMA = 1.22
    /** 张口度 + 唇形通道共同决定是否用 speaking 底图（否则扁/圆唇在 calm 上看不见） */
    const MOUTH_OPEN_ENTER = 0.09
    const MOUTH_OPEN_EXIT = 0.038
    const LIP_SHAPE_ENTER = 0.16
    const LIP_SHAPE_EXIT = 0.052

    const tickMesh = (openness: number, rot: number, jawGain: number, speakOpts?: FillMeshOpts): void => {
      fillMeshPositions(positions, topo, rot, openness, meshW, meshH, jawGain, speakOpts)
      geom.getBuffer('aVertexPosition').update()
    }

    let mouthClosedLatch = true

    /**
     * 元音过渡状态机：A → B 之间用 mesh 做「闭合 → 切贴图 → 张开」过渡，模拟唇间过渡。
     * env: mesh 张口度的额外缩放，1=正常，~0.1=接近闭合
     * 切贴图时机在 close 段的尾部，env 最低，肉眼最不易察觉
     */
    const TRANS_CLOSE_MS = 95
    const TRANS_OPEN_MS = 95
    const TRANS_TROUGH = 0.1
    let vowelCurrent: VowelSlot = 'e'
    let vowelPending: VowelSlot | null = null
    let vowelTransStart = 0
    let lastTexId = -1

    const setTextureIfChanged = (tex: Texture): void => {
      const id = (tex.baseTexture as unknown as { uid?: number }).uid ?? -2
      if (id === lastTexId) return
      lastTexId = id
      mat.texture = tex
    }

    const smooth01 = (x: number): number => {
      const c = Math.min(1, Math.max(0, x))
      return c * c * (3 - 2 * c)
    }

    /** 返回当前应使用的 vowel 与 mesh 张口度缩放 env */
    const stepVowelTransition = (
      nowMs: number,
      raw: VowelSlot,
    ): { vowel: VowelSlot; env: number } => {
      const transitioning = vowelPending !== null
      if (!transitioning) {
        if (raw !== vowelCurrent) {
          vowelPending = raw
          vowelTransStart = nowMs
          return { vowel: vowelCurrent, env: 1 }
        }
        return { vowel: vowelCurrent, env: 1 }
      }

      const dt = nowMs - vowelTransStart
      if (dt < TRANS_CLOSE_MS) {
        const env = 1 - (1 - TRANS_TROUGH) * smooth01(dt / TRANS_CLOSE_MS)
        return { vowel: vowelCurrent, env }
      }
      const dt2 = dt - TRANS_CLOSE_MS
      if (dt2 < TRANS_OPEN_MS) {
        if (vowelPending) {
          vowelCurrent = vowelPending
        }
        const env = TRANS_TROUGH + (1 - TRANS_TROUGH) * smooth01(dt2 / TRANS_OPEN_MS)
        if (raw !== vowelCurrent && vowelPending !== raw) {
          /** 过渡途中目标又变了：完成本次后立即排队下一次 */
          vowelPending = raw
          vowelTransStart = nowMs + TRANS_OPEN_MS - dt2
        }
        return { vowel: vowelCurrent, env }
      }
      vowelPending = null
      if (raw !== vowelCurrent) {
        vowelPending = raw
        vowelTransStart = nowMs
        return { vowel: vowelCurrent, env: TRANS_TROUGH }
      }
      return { vowel: vowelCurrent, env: 1 }
    }

    const resetVowelState = (): void => {
      vowelCurrent = 'e'
      vowelPending = null
      vowelTransStart = 0
    }

    const startPlay = (): void => {
      const text = ta.value.trim()
      if (!text) {
        status.textContent = '请先输入文字'
        return
      }
      mouthClosedLatch = true
      resetVowelState()
      setTextureIfChanged(texCalm)
      mesh.scale.set(1, 1)
      mesh.position.set(0, 0)
      timeline = buildVisemeTimeline(text, 320)
      totalMs = totalDurationMs(timeline)
      playStart = performance.now()
      playing = true
      btnPlay.disabled = true
      status.textContent = `播放中（calm / a–u 口型图 + 弱 mesh）… 共 ${timeline.length} 段`
    }

    const stopPlay = (): void => {
      playing = false
      btnPlay.disabled = false
      resetVowelState()
      setTextureIfChanged(texCalm)
      mesh.scale.set(1, 1)
      mesh.position.set(0, 0)
      tickMesh(0, 0, JAW_IDLE)
      status.textContent = '已停止'
    }

    btnPlay.addEventListener('click', startPlay)
    btnStop.addEventListener('click', stopPlay)

    app.ticker.add(() => {
      subtleT += app.ticker.deltaMS / 1000
      const idleRot = Math.sin(subtleT * 0.7) * 0.042

      if (!playing) {
        setTextureIfChanged(texCalm)
        mesh.scale.set(1, 1)
        mesh.position.set(0, 0)
        tickMesh(0, idleRot, JAW_IDLE)
        return
      }

      const elapsed = performance.now() - playStart
      if (elapsed >= totalMs) {
        playing = false
        btnPlay.disabled = false
        resetVowelState()
        setTextureIfChanged(texCalm)
        mesh.scale.set(1, 1)
        mesh.position.set(0, 0)
        tickMesh(0, idleRot, JAW_IDLE)
        status.textContent = '播放结束'
        return
      }

      const m = sampleMouthTargets(timeline, elapsed)
      const o = m.openness
      const lipE = lipShapeEnergy(m)
      if (mouthClosedLatch) {
        if (o > MOUTH_OPEN_ENTER || lipE > LIP_SHAPE_ENTER) mouthClosedLatch = false
      } else if (o < MOUTH_OPEN_EXIT && lipE < LIP_SHAPE_EXIT) {
        mouthClosedLatch = true
      }

      if (mouthClosedLatch) {
        resetVowelState()
        setTextureIfChanged(texCalm)
        mesh.scale.set(1, 1)
        mesh.position.set(0, 0)
        tickMesh(0, idleRot, JAW_IDLE)
      } else {
        const nowMs = performance.now()
        const rawVowel = sampleVowelSlot(timeline, elapsed)
        const { vowel, env } = stepVowelTransition(nowMs, rawVowel)
        const activeTex = texVowel[vowel]
        setTextureIfChanged(activeTex)
        stabilizeMeshScaleToCalm(mesh, texCalm, activeTex)
        const nudge = vowelNudgeScreen[vowel]
        mesh.position.set(nudge.x, nudge.y)
        const t = elapsed / 1000
        const micro =
          0.007 * Math.sin(t * 12.4) + 0.005 * Math.sin(t * 19.1 + 0.7) + 0.003 * Math.sin(t * 6.8 + 2.1)
        const jawWobble = 0.005 * Math.sin(t * 27.3 + 0.8)
        const oBlend = Math.min(1, Math.max(0, (o * 0.74 + micro + jawWobble) * env))
        const rotSpeak =
          idleRot + o * 0.006 + 0.0024 * Math.sin(t * 23.1) + 0.0016 * Math.sin(t * 41.7 + 1.2)
        const lipSmile = Math.max(
          -1,
          Math.min(
            1,
            0.16 * Math.sin(t * 7.9) + 0.1 * Math.sin(t * 13.6 + 0.9) + 0.045 * Math.sin(t * 18.2 + 0.3),
          ),
        )
        tickMesh(oBlend, rotSpeak, JAW_SPEAKING, {
          parallaxAmp: SPEAK_PARALLAX,
          jawGamma: SPEAK_JAW_GAMMA,
          lipSmile,
          mouthShape: m,
          visemeMeshScale: 0.22 * env,
        })
      }
    })
  })()
}

main()
