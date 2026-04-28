import './real2d/layers/styles.css'

import { AvatarRuntime } from './real2d/runtime/AvatarRuntime.ts'
import { TALK_KEY } from './real2d/engines/SpriteRenderer.ts'
import type { Emotion, Motion } from './real2d/types/index.ts'

export type Real2dLiveUiAdapterOptions = {
  container: HTMLElement
  spriteExpressionDirFileUrl: string
  width: number
  height: number
  onError?: (error: unknown) => void
}

const REAL2D_EMOTIONS: Emotion[] = ['neutral', 'happy', 'sad', 'angry', 'surprised']

function spriteUrl(base: string, id: string): string {
  return new URL(`${id}.png`, base).href
}

export class Real2dLiveUiAdapter {
  private runtime: AvatarRuntime | null = null
  private ready = false
  private pendingEmotion: Emotion = 'neutral'
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

    // Keep this aligned with /real2d demo auto-load: exp01..exp06 are the
    // required expression sprites and exp_open is the optional talk overlay.
    const files: Parameters<AvatarRuntime['loadSpriteSet']>[0] = {
      neutral: spriteUrl(this.opts.spriteExpressionDirFileUrl, 'exp01'),
      happy: spriteUrl(this.opts.spriteExpressionDirFileUrl, 'exp02'),
      sad: spriteUrl(this.opts.spriteExpressionDirFileUrl, 'exp03'),
      angry: spriteUrl(this.opts.spriteExpressionDirFileUrl, 'exp04'),
      surprised: spriteUrl(this.opts.spriteExpressionDirFileUrl, 'exp05'),
      eyes_closed: spriteUrl(this.opts.spriteExpressionDirFileUrl, 'exp06'),
      exp_a: spriteUrl(this.opts.spriteExpressionDirFileUrl, 'exp_a'),
      exp_ee: spriteUrl(this.opts.spriteExpressionDirFileUrl, 'exp_ee'),
      exp_o: spriteUrl(this.opts.spriteExpressionDirFileUrl, 'exp_o'),
      [TALK_KEY]: spriteUrl(this.opts.spriteExpressionDirFileUrl, 'exp_open'),
    }

    await runtime.loadSpriteSet(files)
    runtime.update({ emotion: this.visualEmotion(), speaking: this.pendingMouth > 0.02 })
    runtime.setMouthOpen(this.pendingMouth)
    this.opts.container.style.visibility = 'visible'
    this.ready = true
  }

  resize(width: number, height: number): void {
    this.runtime?.resize(width, height)
  }

  setEmotion(raw: string): void {
    const emotion = this.normalizeEmotion(raw)
    this.pendingEmotion = emotion
    if (!this.ready) return
    this.runtime?.update({ emotion: this.visualEmotion() })
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
        this.runtime?.update({ emotion: this.visualEmotion() })
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
      this.runtime?.update({ emotion: this.pendingEmotion })
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
    return 'neutral'
  }

  private normalizeMotion(raw: string): Motion | null {
    const m = raw.toLowerCase().trim()
    if (m === 'nod' || m === 'shake' || m === 'bounce' || m === 'idle') return m
    return null
  }
}
