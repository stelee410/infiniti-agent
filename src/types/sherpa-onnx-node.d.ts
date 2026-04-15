declare module 'sherpa-onnx-node' {
  interface SenseVoiceModelConfig {
    model: string
    useInverseTextNormalization?: boolean
    language?: string
  }

  interface OfflineModelConfig {
    senseVoice?: SenseVoiceModelConfig
    tokens: string
    numThreads?: number
    debug?: boolean
  }

  interface OfflineRecognizerConfig {
    modelConfig: OfflineModelConfig
  }

  interface WaveObject {
    sampleRate: number
    samples: Float32Array
  }

  interface AcceptWaveformInput {
    sampleRate: number
    samples: Float32Array
  }

  class OfflineStream {
    acceptWaveform(input: AcceptWaveformInput): void
  }

  class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig)
    createStream(): OfflineStream
    decode(stream: OfflineStream): void
    getResult(stream: OfflineStream): Record<string, unknown>
  }

  function readWave(path: string): WaveObject
  function writeWave(path: string, wave: WaveObject): void
}
