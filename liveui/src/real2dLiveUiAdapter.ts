import './real2d/layers/styles.css'

import { AvatarRuntime } from './real2d/runtime/AvatarRuntime.ts'
import { TALK_KEY } from './real2d/engines/SpriteRenderer.ts'
import type { Emotion, Motion } from './real2d/types/index.ts'

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
  private pendingEmotion: Emotion = 'neutral'
  private pendingIntensity = 1
  private pendingMouth = 0
  private speakingVisual = false
  private restoreEmotionTimer: ReturnType<typeof window.setTimeout> | null = null

  constructor(private readonly opts: Real2dLiveUiAdapterOptions) {}

  async init(): Promise<void> {
    this.opts.container.classList.add('liveui-real2d-stage')
    this.opts.container.style.background = 'transparent'
    this.opts.container.style.transform = 'scale(0.8)'
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
    this.opts.container.style.visibility = 'visible'
    this.ready = true
  }

  resize(width: number, height: number): void {
    this.runtime?.resize(width, height)
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
}
