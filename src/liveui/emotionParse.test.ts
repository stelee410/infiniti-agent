import { describe, expect, it } from 'vitest'
import {
  createStreamLiveUiState,
  processAssistantStreamChunk,
  stripLeadingLiveUiTags,
  stripLiveUiTagsFromMessages,
} from './emotionParse.js'

describe('processAssistantStreamChunk', () => {
  it('buffers incomplete leading tag', () => {
    const st = createStreamLiveUiState()
    expect(processAssistantStreamChunk(st, '[Ha').displayText).toBe('')
    expect(processAssistantStreamChunk(st, '[Happy]').newActions.length).toBeGreaterThan(0)
    expect(processAssistantStreamChunk(st, '[Happy]你好').displayText).toBe('你好')
  })

  it('emits actions only once per new tag prefix', () => {
    const st = createStreamLiveUiState()
    const a = processAssistantStreamChunk(st, '[Happy]')
    expect(a.newActions).toEqual([{ expression: 'happy' }])
    const b = processAssistantStreamChunk(st, '[Happy]abc')
    expect(b.newActions).toEqual([])
    expect(b.displayText).toBe('abc')
  })

  it('maps Fear and Smirk to expressions for sprite / Live2D', () => {
    const st = createStreamLiveUiState()
    expect(processAssistantStreamChunk(st, '[Fear]x').newActions).toEqual([{ expression: 'sad' }])
    const st2 = createStreamLiveUiState()
    expect(processAssistantStreamChunk(st2, '[Smirk]y').newActions).toEqual([{ expression: 'smirk' }])
  })
})

describe('stripLeadingLiveUiTags', () => {
  it('removes only leading tags', () => {
    expect(stripLeadingLiveUiTags('[Sad] hello [x]')).toBe('hello [x]')
  })
})

describe('stripLiveUiTagsFromMessages', () => {
  it('strips assistant string content', () => {
    const out = stripLiveUiTagsFromMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '[Happy]OK' },
    ])
    expect(out[1]).toEqual({ role: 'assistant', content: 'OK' })
  })
})
