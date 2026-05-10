import { describe, expect, it } from 'vitest'
import { H5AppletManager, H5AppletValidator } from './appletRuntime.js'
import { showMeMagicAppletHtml } from './showMeMagicApplet.js'

describe('H5AppletValidator', () => {
  it('injects CSP and bridge script into valid HTML', () => {
    const validator = new H5AppletValidator()
    const result = validator.validateHtml(
      '<!doctype html><html><head><title>x</title></head><body><button>Go</button></body></html>',
      { network: false, storage: 'session' },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.html).toContain('Content-Security-Policy')
      expect(result.html).toContain('__LINKYUN_APPLET__')
    }
  })

  it('blocks dangerous APIs and remote scripts', () => {
    const validator = new H5AppletValidator()
    const result = validator.validateHtml(
      '<script src="https://example.com/x.js"></script><script>eval("1+1")</script>',
      { network: false, storage: 'session' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContain('external scripts are not allowed')
      expect(result.errors).toContain('eval() is not allowed')
    }
  })

  it('blocks network APIs without network permission', () => {
    const validator = new H5AppletValidator()
    const result = validator.validateHtml(
      '<script>fetch("https://example.com")</script>',
      { network: false, storage: 'session' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toContain('fetch() requires network permission')
  })

  it('accepts the official Show Me Magic test applet', () => {
    const validator = new H5AppletValidator()
    const result = validator.validateHtml(
      showMeMagicAppletHtml(),
      { network: false, storage: 'session' },
    )
    expect(result.ok).toBe(true)
  })
})

describe('H5AppletManager', () => {
  it('creates, updates, and destroys applets', () => {
    const manager = new H5AppletManager()
    const created = manager.create({
      title: 'Lucky Wheel',
      html: '<html><body><button>Spin</button></body></html>',
    })
    expect(created.appId).toMatch(/^applet_/)
    expect(created.status).toBe('running')

    const patched = manager.update({
      appId: created.appId,
      patchType: 'css',
      content: 'button { color: red; }',
    })
    expect(patched.status).toBe('updated')

    const destroyed = manager.destroy(created.appId)
    expect(destroyed.status).toBe('destroyed')
  })
})
