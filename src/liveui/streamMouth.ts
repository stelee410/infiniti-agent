/**
 * 无 TTS 音频流时，用助手流式文本的“字符吞吐”近似 RMS，驱动口型 ParamMouthOpenY。
 * 接入真实 PCM 后，可替换为 RMS 归一化值写入同一通道。
 */
export class StreamMouthEstimator {
  private lastLen = 0
  private lastAt = performance.now()
  private smoothed = 0
  private active = false

  reset(): void {
    this.lastLen = 0
    this.lastAt = performance.now()
    this.smoothed = 0
    this.active = false
  }

  /** 当前展示文本（已剥标签）长度变化时调用 */
  onDisplayText(displayText: string): void {
    const n = displayText.length
    const now = performance.now()
    const dt = Math.max(0.001, (now - this.lastAt) / 1000)
    const dChars = Math.max(0, n - this.lastLen)
    this.lastLen = n
    this.lastAt = now
    const cps = dChars / dt
    const raw = Math.min(1, cps / 48)
    this.smoothed = this.smoothed * 0.82 + raw * 0.18
    this.active = true
  }

  /** 无新字时口型自然回落 */
  tickIdle(): void {
    this.smoothed *= 0.88
    if (this.smoothed < 0.02) {
      this.smoothed = 0
      this.active = false
    }
  }

  get mouthOpen01(): number {
    return Math.max(0, Math.min(1, this.smoothed * 1.15))
  }
}
