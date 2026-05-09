import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  deleteCachedH5Applet,
  findCachedH5Applet,
  h5AppletCacheKey,
  listCachedH5Applets,
  readCachedH5Applet,
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

  it('deletes cached applets by key/id or title', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'infiniti-h5-cache-delete-'))
    try {
      const first = await writeCachedH5Applet(cwd, {
        title: 'Show Me Magic',
        description: '官方测试页',
        launchMode: 'live_panel',
        permissions: { network: false, storage: 'session' },
        html: '<html><body>magic</body></html>',
      })
      const second = await writeCachedH5Applet(cwd, {
        title: '幸运转盘',
        description: '',
        launchMode: 'live_panel',
        permissions: { network: false, storage: 'session' },
        html: '<html><body>wheel</body></html>',
      })

      expect((await deleteCachedH5Applet(cwd, { keyOrId: first.key }))?.title).toBe('Show Me Magic')
      expect(await readCachedH5Applet(cwd, first.key)).toBeNull()

      expect((await deleteCachedH5Applet(cwd, { title: '幸运转盘' }))?.key).toBe(second.key)
      expect(await listCachedH5Applets(cwd)).toEqual([])
      expect(await deleteCachedH5Applet(cwd, { title: '不存在' })).toBeNull()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
