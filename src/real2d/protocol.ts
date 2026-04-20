import type { Real2dPhoneme } from './phonemeState.js'

/** TUI / 主进程 → 渲染进程（或测试客户端） */
export type Real2dClientMessage =
  | {
      type: 'real2d_drive'
      rotationX: number
      phoneme: Real2dPhoneme
      /** 0..1，可选：由主进程情绪解析器填入 */
      emotionIntensity?: number
      /** OMNIA 等同频预留（Hz） */
      vibeFrequency?: number
    }
  | { type: 'real2d_ping'; nonce?: string }

/** 渲染进程订阅用快照（可高频广播） */
export type Real2dStatePayload = {
  rotationX: number
  phoneme: Real2dPhoneme
  jawOpen: number
  mouthLayerB: number
  breathY: number
  gazeX: number
  gazeY: number
  emotionIntensity: number
  vibeFrequency: number
  /** Luna 表情 PNG 文件名，如 exp_01.png */
  faceTexture: string
  /** 鼻区附近代表顶点 X 位移（相对无旋转），用于验收 Parallax */
  parallaxSampleDx: number
  tMillis: number
}

export type Real2dServerMessage =
  | { type: 'real2d_hello'; version: 1 }
  | { type: 'real2d_state'; data: Real2dStatePayload }
  | { type: 'real2d_pong'; nonce?: string }
