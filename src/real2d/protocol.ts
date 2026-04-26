export type Real2dFrameFormat = 'jpeg' | 'webp' | 'png' | 'raw'

export type Real2dMouthDriver = 'rms' | 'musetalk' | 'wav2lip'

export type Real2dBackend = 'local' | 'fal'

export type Real2dFalConfig = {
  apiKey?: string
  keyEnv?: string
  mode?: 'live-portrait' | 'live-portrait-image' | 'lipsync-video'
  model?: string
  imageModel?: string
  lipsyncModel?: string
  drivingVideoUrl?: string
  imageUrl?: string
  audioUrl?: string
  pollIntervalMs?: number
  requestTimeoutMs?: number
  options?: Record<string, number | boolean>
}

export type Real2dParamVector = {
  smile?: number
  eyeOpen?: number
  brow?: number
  mouthOpen?: number
  pitch?: number
  yaw?: number
  roll?: number
  [key: string]: number | undefined
}

export type Real2dHealth = {
  ok: boolean
  ready?: boolean
  backend?: string
  fps?: number
  latencyMs?: number
  message?: string
}

export type Real2dStartRequest = {
  sessionId: string
  backend?: Real2dBackend
  sourceImage?: string
  fps?: number
  frameFormat?: Real2dFrameFormat
  fal?: Real2dFalConfig
}

export type Real2dStartResponse = {
  sessionId: string
  ready: boolean
  backend?: string
  streamUrl?: string
}

export type Real2dParamUpdate = {
  type: 'PARAM_UPDATE'
  sessionId: string
  timestampMs: number
  emotion?: string
  params: Real2dParamVector
  transitionMs?: number
}

export type Real2dAudioChunk = {
  type: 'AUDIO_CHUNK'
  sessionId: string
  format: 'mp3' | 'wav' | 'pcm_s16le'
  sampleRate: number
  channels: number
  sequence: number
  audioBase64: string
}

export type Real2dStatus = {
  type: 'REAL2D_STATUS'
  ready: boolean
  fps?: number
  latencyMs?: number
  backend?: string
  message?: string
}

export type Real2dFrame = {
  type: 'REAL2D_FRAME'
  sessionId: string
  timestampMs: number
  format: Real2dFrameFormat
  frameBase64: string
}
