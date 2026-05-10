import { describe, expect, it, vi } from 'vitest'

import type { PersistedMessage } from '../llm/persisted.js'
import { sendLiveUiAssistantDone } from './liveUiStreamCompletion.js'

describe('sendLiveUiAssistantDone', () => {
  it('sends a final assistant stream frame with done=true after the run loop completes', () => {
    const sendAssistantStream = vi.fn()
    const messages: PersistedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi from infiniti' },
    ]

    sendLiveUiAssistantDone({ sendAssistantStream }, messages)

    expect(sendAssistantStream).toHaveBeenCalledOnce()
    expect(sendAssistantStream).toHaveBeenCalledWith('hi from infiniti', false, true)
  })

  it('does not emit a completion frame when the final message is not assistant text', () => {
    const sendAssistantStream = vi.fn()
    const messages: PersistedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'tool', toolCallId: 'tool-1', name: 'read', content: 'done' },
    ]

    sendLiveUiAssistantDone({ sendAssistantStream }, messages)

    expect(sendAssistantStream).not.toHaveBeenCalled()
  })

  it('is a no-op when no live UI session is attached', () => {
    const messages: PersistedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi from infiniti' },
    ]

    expect(() => sendLiveUiAssistantDone(null, messages)).not.toThrow()
  })
})
