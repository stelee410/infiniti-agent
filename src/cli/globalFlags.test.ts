import { describe, expect, it } from 'vitest'
import { parseGlobalFlags } from './globalFlags.js'

describe('parseGlobalFlags', () => {
  it('removes known global flags and preserves command args', () => {
    expect(parseGlobalFlags([
      '--debug',
      'live',
      '--port',
      '8081',
      '--dangerously-skip-permissions',
      '--disable-thinking',
    ])).toEqual({
      argv: ['live', '--port', '8081'],
      debug: true,
      skipPermissions: true,
      disableThinking: true,
    })
  })

  it('leaves unknown flags for commander', () => {
    expect(parseGlobalFlags(['chat', '--unknown'])).toEqual({
      argv: ['chat', '--unknown'],
      debug: false,
      skipPermissions: false,
      disableThinking: false,
    })
  })
})
