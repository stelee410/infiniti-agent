import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  findCachedH5Applet,
  h5AppletCacheKey,
  listCachedH5Applets,
  writeCachedH5Applet,
} from './h5AppletCache.js'

describe('h5AppletCache', () => {
  it('writes, lists, and finds cached applets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'infiniti-h5-cache-'))
    try {
      const saved = await writeCachedH5Applet(cwd, {
        title: '幸运转盘',
        description: '直播抽奖',
        launchMode: 'live_panel',
        permissions: { network: false, storage: 'session' },
        html: '<html><body>ok</body></html>',
      })
      expect(saved.key).toBe(h5AppletCacheKey('幸运转盘', '直播抽奖'))

      const items = await listCachedH5Applets(cwd)
      expect(items).toHaveLength(1)
      expect(items[0]?.title).toBe('幸运转盘')

      const found = await findCachedH5Applet(cwd, '幸运转盘', '直播抽奖')
      expect(found?.html).toContain('ok')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
