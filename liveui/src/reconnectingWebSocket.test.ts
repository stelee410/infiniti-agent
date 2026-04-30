import { describe, expect, it } from 'vitest'
import {
  BACKOFF_JITTER_MS,
  computeReconnectDelay,
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
} from './reconnectingWebSocket.js'

describe('computeReconnectDelay', () => {
  it('uses exponential backoff with deterministic jitter', () => {
    expect(computeReconnectDelay(0, { random: () => 0 })).toBe(MIN_BACKOFF_MS)
    expect(computeReconnectDelay(1, { random: () => 0 })).toBe(MIN_BACKOFF_MS * 2)
    expect(computeReconnectDelay(2, { random: () => 0.5 })).toBe(
      MIN_BACKOFF_MS * 4 + Math.floor(BACKOFF_JITTER_MS * 0.5),
    )
  })

  it('caps the exponential base at the max delay', () => {
    expect(computeReconnectDelay(99, { random: () => 0 })).toBe(MAX_BACKOFF_MS)
  })

  it('treats negative and fractional attempts as a safe integer', () => {
    expect(computeReconnectDelay(-4, { random: () => 0 })).toBe(MIN_BACKOFF_MS)
    expect(computeReconnectDelay(1.9, { random: () => 0 })).toBe(MIN_BACKOFF_MS * 2)
  })

  it('supports custom timing knobs for tests and future tuning', () => {
    expect(computeReconnectDelay(3, {
      minMs: 100,
      maxMs: 500,
      jitterMs: 10,
      random: () => 0.9,
    })).toBe(509)
  })
})
