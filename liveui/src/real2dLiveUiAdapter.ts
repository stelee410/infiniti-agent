import './real2d/layers/styles.css'

import { AvatarRuntime } from './real2d/runtime/AvatarRuntime.ts'
import { TALK_KEY } from './real2d/engines/SpriteRenderer.ts'
import type { Emotion, Gaze, Motion } from './real2d/types/index.ts'

export type Real2dExpressionSlot =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'eyes_closed'
  | 'exp_a'
  | 'exp_ee'
  | 'exp_o'
  | typeof TALK_KEY

export type Real2dLiveUiAdapterOptions = {
  container: HTMLElement
  spriteExpressionDirFileUrl: string
  expressionIds?: Partial<Record<Real2dExpressionSlot, string>>
  figureZoom?: number
  width: number
  height: number
  onError?: (error: unknown) => void
}

const REAL2D_EMOTIONS: Emotion[] = ['neutral', 'happy', 'sad', 'angry', 'thinking', 'surprised', 'shy']

const DEFAULT_REAL2D_EXPRESSION_IDS: Record<Real2dExpressionSlot, string> = {
  neutral: 'exp01',
  happy: 'exp02',
  sad: 'exp03',
  angry: 'exp04',
  surprised: 'exp05',
  eyes_closed: 'exp06',
  exp_a: 'exp_a',
  exp_ee: 'exp_ee',
  exp_o: 'exp_o',
  [TALK_KEY]: TALK_KEY,
}

function spriteUrl(base: string, id: string): string {
  return new URL(`${id}.png`, base).href
}

export class Real2dLiveUiAdapter {
  private runtime: AvatarRuntime | null = null
  private ready = false
  private figureZoom = 1
  private stageScaleCompensation = 1
  private verticalOffsetPx = 0
  private pendingEmotion: Emotion = 'neutral'
  private pendingIntensity = 1
  private pendingMouth = 0
  private speakingVisual = false
  private restoreEmotionTimer: ReturnType<typeof window.setTimeout> | null = null

  constructor(private readonly opts: Real2dLiveUiAdapterOptions) {}

  async init(): Promise<void> {
    this.opts.container.classList.add('liveui-real2d-stage')
    this.opts.container.style.background = 'transparent'
    const figureZoom =
      typeof this.opts.figureZoom === 'number' && Number.isFinite(this.opts.figureZoom)
        ? Math.max(0.4, Math.min(1.5, this.opts.figureZoom))
        : 1
    this.figureZoom = figureZoom
    this.applyContainerTransform()
    this.opts.container.style.transformOrigin = '50% 72%'
    this.opts.container.style.visibility = 'hidden'

    const runtime = new AvatarRuntime({
      container: this.opts.container,
      width: this.opts.width,
      height: this.opts.height,
      autoConnect: false,
      onError: (_code, detail) => this.opts.onError?.(detail),
    }).init().start()

    this.runtime = runtime
    runtime.setScene('transparent', 'neutral')

    const expressionId = (slot: Real2dExpressionSlot): string =>
      this.opts.expressionIds?.[slot]?.trim() || DEFAULT_REAL2D_EXPRESSION_IDS[slot]

    // Keep this aligned with /real2d demo auto-load by default: exp01..exp06
    // are the required expression sprites and exp_open is the optional talk overlay.
    // A real2d-specific expressions.json can override these ids when an avatar
    // package uses a different semantic order from spriteExpressions mode.
    const files: Parameters<AvatarRuntime['loadSpriteSet']>[0] = {
      neutral: spriteUrl(this.opts.spriteExpressionDirFileUrl, expressionId('neutral')),
      happy: spriteUrl(this.opts.spriteExpressionDirFileUrl, expressionId('happy')),
      sad: spriteUrl(this.opts.spriteExpressionDirFileUrl, expressionId('sad')),
      angry: spriteUrl(this.opts.spriteExpressionDirFileUrl, expressionId('angry')),
      surprised: spriteUrl(this.opts.spriteExpressionDirFileUrl, expressionId('surprised')),
      eyes_closed: spriteUrl(this.opts.spriteExpressionDirFileUrl, expressionId('eyes_closed')),
      exp_a: spriteUrl(this.opts.spriteExpressionDirFileUrl, expressionId('exp_a')),
      exp_ee: spriteUrl(this.opts.spriteExpressionDirFileUrl, expressionId('exp_ee')),
      exp_o: spriteUrl(this.opts.spriteExpressionDirFileUrl, expressionId('exp_o')),
      [TALK_KEY]: spriteUrl(this.opts.spriteExpressionDirFileUrl, expressionId(TALK_KEY)),
    }

    await runtime.loadSpriteSet(files)
    runtime.update({ emotion: this.visualEmotion(), intensity: this.pendingIntensity, speaking: this.pendingMouth > 0.02 })
    runtime.setMouthOpen(this.pendingMouth)
    this.ready = true
  }

  resize(width: number, height: number): void {
    this.runtime?.resize(width, height)
  }

  setVisible(visible: boolean): void {
    this.opts.container.style.visibility = visible ? 'visible' : 'hidden'
  }

  setVerticalOffset(offsetPx: number): void {
    if (!Number.isFinite(offsetPx)) return
    this.verticalOffsetPx = Math.round(offsetPx)
    this.applyContainerTransform()
  }

  getVerticalOffset(): number {
    return this.verticalOffsetPx
  }

  setStageScaleCompensation(value: number): void {
    if (!Number.isFinite(value)) return
    this.stageScaleCompensation = Math.max(0.7, Math.min(1.6, value))
    this.applyContainerTransform()
  }

  getStageScaleCompensation(): number {
    return this.stageScaleCompensation
  }

  getVisualBounds(): DOMRect | null {
    const canvas = this.opts.container.querySelector('canvas.avr-avatar') as HTMLCanvasElement | null
    if (!canvas) return null
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx || canvas.width <= 0 || canvas.height <= 0) return null
    try {
      const step = Math.max(2, Math.floor(Math.min(canvas.width, canvas.height) / 220))
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let minX = canvas.width
      let minY = canvas.height
      let maxX = -1
      let maxY = -1
      for (let y = 0; y < canvas.height; y += step) {
        for (let x = 0; x < canvas.width; x += step) {
          if (data[(y * canvas.width + x) * 4 + 3] <= 8) continue
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
      if (maxX < minX || maxY < minY) return null
      const rect = canvas.getBoundingClientRect()
      const scaleX = rect.width / canvas.width
      const scaleY = rect.height / canvas.height
      return new DOMRect(
        rect.left + minX * scaleX,
        rect.top + minY * scaleY,
        Math.max(1, (maxX - minX + step) * scaleX),
        Math.max(1, (maxY - minY + step) * scaleY),
      )
    } catch {
      return null
    }
  }

  private applyContainerTransform(): void {
    const scale = this.figureZoom * this.stageScaleCompensation
    this.opts.container.style.transform = `translateY(${this.verticalOffsetPx}px) scale(${scale})`
  }

  setEmotion(raw: string, intensity?: number): void {
    const emotion = this.normalizeEmotion(raw)
    this.pendingEmotion = emotion
    if (typeof intensity === 'number' && Number.isFinite(intensity)) {
      this.pendingIntensity = Math.max(0, Math.min(1.4, intensity))
    }
    if (!this.ready) return
    this.runtime?.update({ emotion: this.visualEmotion(), intensity: this.pendingIntensity })
  }

  setMouthOpen(value01: number): void {
    const v = Math.max(0, Math.min(1, value01))
    this.pendingMouth = v
    if (!this.ready) return
    const nextSpeakingVisual = v > 0.02
    if (nextSpeakingVisual !== this.speakingVisual) {
      this.speakingVisual = nextSpeakingVisual
      if (nextSpeakingVisual) {
        this.clearRestoreEmotionTimer()
        this.runtime?.update({ emotion: this.visualEmotion(), intensity: this.pendingIntensity })
      } else {
        this.scheduleRestoreEmotion()
      }
    }
    this.runtime?.setMouthOpen(v)
  }

  clearMouthOpen(): void {
    this.pendingMouth = 0
    if (!this.ready) return
    this.runtime?.setMouthOpen(0)
  }

  setGaze(raw: string): void {
    const gaze = this.normalizeGaze(raw)
    if (!gaze || !this.ready) return
    this.runtime?.update({ gaze })
  }

  triggerMotion(raw: string): void {
    const motion = this.normalizeMotion(raw)
    if (!motion || !this.ready) return
    this.runtime?.update({ motion })
  }

  destroy(): void {
    this.runtime?.destroy()
    this.runtime = null
    this.ready = false
    this.speakingVisual = false
    this.clearRestoreEmotionTimer()
  }

  private visualEmotion(): Emotion {
    return this.speakingVisual ? 'neutral' : this.pendingEmotion
  }

  private scheduleRestoreEmotion(): void {
    this.clearRestoreEmotionTimer()
    const delayMs = 2000 + Math.round(Math.random() * 1000)
    this.restoreEmotionTimer = window.setTimeout(() => {
      this.restoreEmotionTimer = null
      if (!this.ready || this.speakingVisual) return
      this.runtime?.update({ emotion: this.pendingEmotion, intensity: this.pendingIntensity })
    }, delayMs)
  }

  private clearRestoreEmotionTimer(): void {
    if (this.restoreEmotionTimer === null) return
    window.clearTimeout(this.restoreEmotionTimer)
    this.restoreEmotionTimer = null
  }

  private normalizeEmotion(raw: string): Emotion {
    const e = raw.toLowerCase().trim()
    if ((REAL2D_EMOTIONS as string[]).includes(e)) return e as Emotion
    if (e === 'joy') return 'happy'
    if (e === 'sadness' || e === 'fear' || e === 'frown') return 'sad'
    if (e === 'anger') return 'angry'
    if (e === 'surprise') return 'surprised'
    if (e === 'think') return 'thinking'
    if (e === 'blush') return 'shy'
    if (e === 'smirk' || e === 'disgust') return 'happy'
    return 'neutral'
  }

  private normalizeMotion(raw: string): Motion | null {
    const m = raw.toLowerCase().trim()
    if (m === 'nod' || m === 'shake' || m === 'bounce' || m === 'idle') return m
    return null
  }

  private normalizeGaze(raw: string): Gaze | null {
    const g = raw.toLowerCase().trim()
    if (g === 'center' || g === 'left' || g === 'right' || g === 'up' || g === 'down' || g === 'close') {
      return g
    }
    return null
  }
}
