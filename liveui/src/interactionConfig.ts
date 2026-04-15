/**
 * Live2D 空闲小动作与点击分区（可按模型 motion 名微调）。
 * 见 `liveui/src/main.ts` 中的使用处。
 */
export const LIVE2D_IDLE = {
  /** 无对话活动多少秒后尝试播一条「摸鱼」动作 */
  idleSeconds: 30,
  /** 检查间隔（毫秒） */
  pollIntervalMs: 4000,
  /**
   * 随机尝试的 motion（group / index）；按顺序尝试，首个 Promise resolve true 即停。
   * mao_pro 常见为 Idle 多段；无则静默失败。
   */
  motionPool: [
    { group: 'Idle', index: 0 },
    { group: 'Idle', index: 1 },
    { group: 'Idle', index: 2 },
    { group: 'Idle', index: 3 },
  ] as { group: string; index: number }[],
} as const

/** 戳身体时依次尝试的 motion（TapBody / Flick 等依模型而定） */
export const LIVE2D_BODY_POKE_MOTIONS = [
  { group: 'TapBody', index: 0 },
  { group: 'tap_body', index: 0 },
  { group: 'Flick', index: 0 },
] as const

/** hitTest 返回名匹配（不区分大小写） */
export const HIT_HEAD_RE = /head|face|hair|顔|髪|头/i
export const HIT_BODY_RE = /body|chest|breast|胸|腹|体/i
