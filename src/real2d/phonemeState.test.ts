import { describe, expect, it } from 'vitest'
import { PhonemeStateMachine } from './phonemeState.js'

describe('PhonemeStateMachine', () => {
  it('M→A 在 60ms 内将 jawOpen 插到 1', () => {
    const p = new PhonemeStateMachine()
    p.setPhoneme('M')
    p.tick(20)
    expect(p.getDrive().jawOpen).toBe(0)
    p.setPhoneme('A')
    p.tick(30)
    expect(p.getDrive().jawOpen).toBeGreaterThan(0.4)
    expect(p.getDrive().jawOpen).toBeLessThan(1)
    p.tick(30)
    expect(p.getDrive().jawOpen).toBe(1)
    expect(p.getDrive().mouthLayerB).toBe(1)
  })
})
