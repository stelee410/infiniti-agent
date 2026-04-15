import type { LlmProvider } from './types.js'

/** 默认指向各厂商公开端点与近期稳定/旗舰模型，可按需在 init 或 config 中覆盖。 */
export const PROVIDER_DEFAULTS: Record<
  LlmProvider,
  { baseUrl: string; model: string }
> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
  },
  minimax: {
    baseUrl: 'https://api.minimax.io/v1',
    model: 'MiniMax-M2.7',
  },
}
