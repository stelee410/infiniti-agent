import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { isAllowedLiveUiMediaPath } from './wsSession.js'

describe('isAllowedLiveUiMediaPath', () => {
  it('allows files under configured media roots', () => {
    const root = resolve('/tmp/infiniti-agent/.infiniti-agent')
    expect(isAllowedLiveUiMediaPath(join(root, 'inbox/assets/video.mp4'), [root])).toBe(true)
  })

  it('rejects absolute paths outside configured media roots', () => {
    const root = resolve('/tmp/infiniti-agent/.infiniti-agent')
    expect(isAllowedLiveUiMediaPath('/etc/passwd', [root])).toBe(false)
  })
})
