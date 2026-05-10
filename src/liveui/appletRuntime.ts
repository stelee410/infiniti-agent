export type H5AppletLaunchMode = 'live_panel' | 'floating' | 'fullscreen' | 'overlay'

export type H5AppletStoragePermission = false | 'session'

export type H5AppletPermissions = {
  network: boolean
  storage: H5AppletStoragePermission
  microphone?: boolean
  camera?: boolean
  clipboard?: boolean
  fullscreen?: boolean
}

export type H5AppletStatus = 'created' | 'validated' | 'mounted' | 'running' | 'updated' | 'destroyed'

export type H5AppletRecord = {
  appId: string
  title: string
  description: string
  launchMode: H5AppletLaunchMode
  permissions: H5AppletPermissions
  html: string
  status: H5AppletStatus
  createdAt: string
  updatedAt: string
}

export type H5AppletCreateInput = {
  title: string
  description?: string
  launchMode?: H5AppletLaunchMode
  permissions?: Partial<H5AppletPermissions>
  html: string
}

export type H5AppletPatchType = 'replace' | 'css' | 'state'

export type H5AppletUpdateInput = {
  appId: string
  patchType: H5AppletPatchType
  content: string
}

export type H5AppletValidationResult =
  | { ok: true; html: string }
  | { ok: false; errors: string[] }

export const DEFAULT_H5_APPLET_PERMISSIONS: H5AppletPermissions = {
  network: false,
  storage: 'session',
  microphone: false,
  camera: false,
  clipboard: false,
  fullscreen: false,
}

const MAX_APPLET_HTML_CHARS = 240_000
const MAX_APPLET_PATCH_CHARS = 120_000

const FORBIDDEN_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /\beval\s*\(/i, message: 'eval() is not allowed' },
  { re: /\bFunction\s*\(/i, message: 'Function() is not allowed' },
  { re: /\bimport\s*\(/i, message: 'dynamic import() is not allowed' },
  { re: /\bWorker\s*\(/i, message: 'Worker is not allowed' },
  { re: /\bSharedWorker\s*\(/i, message: 'SharedWorker is not allowed' },
  { re: /\bServiceWorker\b/i, message: 'ServiceWorker is not allowed' },
  { re: /\bdocument\.cookie\b/i, message: 'document.cookie is not allowed' },
  { re: /\bwindow\.top\b/i, message: 'window.top access is not allowed' },
  { re: /\btop\.location\b/i, message: 'top.location access is not allowed' },
  { re: /<\s*base\b/i, message: '<base> is not allowed' },
  { re: /<\s*object\b/i, message: '<object> is not allowed' },
  { re: /<\s*embed\b/i, message: '<embed> is not allowed' },
  { re: /<\s*iframe\b/i, message: 'nested iframe is not allowed' },
  { re: /<\s*script\b[^>]*\bsrc\s*=/i, message: 'external scripts are not allowed' },
  { re: /\bonline\s*=/i, message: 'inline online handlers are not allowed' },
]

export class H5AppletValidator {
  validateHtml(html: string, permissions: H5AppletPermissions): H5AppletValidationResult {
    const errors: string[] = []
    if (!html.trim()) errors.push('html is required')
    if (html.length > MAX_APPLET_HTML_CHARS) {
      errors.push(`html exceeds ${MAX_APPLET_HTML_CHARS} characters`)
    }

    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.re.test(html)) errors.push(rule.message)
    }

    if (!permissions.network) {
      if (/\bfetch\s*\(/i.test(html)) errors.push('fetch() requires network permission')
      if (/\bXMLHttpRequest\b/i.test(html)) errors.push('XMLHttpRequest requires network permission')
      if (/\bWebSocket\s*\(/i.test(html)) errors.push('WebSocket requires network permission')
      if (/\bEventSource\s*\(/i.test(html)) errors.push('EventSource requires network permission')
      if (/\b(?:src|href)\s*=\s*["']https?:\/\//i.test(html)) {
        errors.push('remote src/href requires network permission')
      }
    }

    if (!permissions.storage) {
      if (/\blocalStorage\b/i.test(html)) errors.push('localStorage requires storage permission')
      if (/\bsessionStorage\b/i.test(html)) errors.push('sessionStorage requires storage permission')
      if (/\bindexedDB\b/i.test(html)) errors.push('indexedDB requires storage permission')
    } else if (permissions.storage === 'session') {
      if (/\blocalStorage\b/i.test(html)) errors.push('localStorage is not allowed for session storage')
      if (/\bindexedDB\b/i.test(html)) errors.push('indexedDB is not allowed for session storage')
    }

    if (!permissions.clipboard && /\bnavigator\.clipboard\b/i.test(html)) {
      errors.push('clipboard requires clipboard permission')
    }
    if (!permissions.microphone && /\bgetUserMedia\s*\(/i.test(html)) {
      errors.push('camera/microphone capture requires explicit permission')
    }

    if (errors.length) return { ok: false, errors: [...new Set(errors)] }
    return { ok: true, html: injectRuntimeEnvelope(html, permissions) }
  }

  validatePatch(input: H5AppletUpdateInput, permissions: H5AppletPermissions): H5AppletValidationResult {
    if (!input.content.trim()) return { ok: false, errors: ['content is required'] }
    if (input.content.length > MAX_APPLET_PATCH_CHARS) {
      return { ok: false, errors: [`content exceeds ${MAX_APPLET_PATCH_CHARS} characters`] }
    }
    if (input.patchType === 'replace') return this.validateHtml(input.content, permissions)
    if (input.patchType === 'css') {
      if (/<\s*script\b/i.test(input.content) || /@import\s+url\s*\(/i.test(input.content)) {
        return { ok: false, errors: ['css patch cannot contain scripts or @import url()'] }
      }
      if (!permissions.network && /url\s*\(\s*["']?https?:\/\//i.test(input.content)) {
        return { ok: false, errors: ['remote CSS urls require network permission'] }
      }
    }
    return { ok: true, html: input.content }
  }
}

export class H5AppletManager {
  private readonly applets = new Map<string, H5AppletRecord>()
  private seq = 0
  private readonly validator = new H5AppletValidator()

  create(input: H5AppletCreateInput): H5AppletRecord {
    const permissions = normalizePermissions(input.permissions)
    const title = input.title.trim()
    if (!title) throw new Error('title is required')
    const validation = this.validator.validateHtml(input.html, permissions)
    if (!validation.ok) throw new Error(validation.errors.join('; '))

    const now = new Date().toISOString()
    const appId = `applet_${Date.now().toString(36)}_${(++this.seq).toString(36)}`
    const record: H5AppletRecord = {
      appId,
      title,
      description: input.description?.trim() ?? '',
      launchMode: input.launchMode ?? 'live_panel',
      permissions,
      html: validation.html,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    }
    this.applets.set(appId, record)
    return record
  }

  update(input: H5AppletUpdateInput): H5AppletRecord {
    const current = this.applets.get(input.appId)
    if (!current || current.status === 'destroyed') throw new Error('applet not found')
    const validation = this.validator.validatePatch(input, current.permissions)
    if (!validation.ok) throw new Error(validation.errors.join('; '))
    const updated: H5AppletRecord = {
      ...current,
      html: input.patchType === 'replace' ? validation.html : current.html,
      status: 'updated',
      updatedAt: new Date().toISOString(),
    }
    this.applets.set(input.appId, updated)
    return updated
  }

  markRunning(appId: string): void {
    const current = this.applets.get(appId)
    if (!current || current.status === 'destroyed') return
    this.applets.set(appId, { ...current, status: 'running', updatedAt: new Date().toISOString() })
  }

  destroy(appId: string): H5AppletRecord {
    const current = this.applets.get(appId)
    if (!current || current.status === 'destroyed') throw new Error('applet not found')
    const destroyed: H5AppletRecord = {
      ...current,
      status: 'destroyed',
      updatedAt: new Date().toISOString(),
    }
    this.applets.set(appId, destroyed)
    return destroyed
  }

  get(appId: string): H5AppletRecord | undefined {
    return this.applets.get(appId)
  }

  list(): H5AppletRecord[] {
    return [...this.applets.values()]
  }
}

export function normalizePermissions(raw: Partial<H5AppletPermissions> | undefined): H5AppletPermissions {
  return {
    ...DEFAULT_H5_APPLET_PERMISSIONS,
    ...(raw ?? {}),
    network: raw?.network === true,
    storage: raw?.storage === false ? false : raw?.storage === 'session' ? 'session' : DEFAULT_H5_APPLET_PERMISSIONS.storage,
    microphone: raw?.microphone === true,
    camera: raw?.camera === true,
    clipboard: raw?.clipboard === true,
    fullscreen: raw?.fullscreen === true,
  }
}

function injectRuntimeEnvelope(html: string, permissions: H5AppletPermissions): string {
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data:${permissions.network ? ' https: http:' : ''}`,
    "font-src 'none'",
    permissions.network ? 'connect-src https: http: wss: ws:' : "connect-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">`
  const bridge = `<script>
(() => {
  const fitToViewport = () => {
    const body = document.body;
    const root = document.documentElement;
    if (!body || !root) return;
    body.style.transform = "none";
    body.style.transformOrigin = "top center";
    root.style.overflow = "hidden";
    body.style.overflow = "visible";
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const rect = body.getBoundingClientRect();
    const contentW = Math.max(body.scrollWidth, root.scrollWidth, rect.width, vw);
    const contentH = Math.max(body.scrollHeight, root.scrollHeight, rect.height, vh);
    const scale = Math.min(1, vw / contentW, vh / contentH);
    body.style.width = scale < 1 ? Math.floor(vw / scale) + "px" : "";
    body.style.minHeight = scale < 1 ? Math.floor(vh / scale) + "px" : "";
    body.style.transform = scale < 1 ? "scale(" + scale + ")" : "none";
  };
  window.addEventListener("resize", fitToViewport);
  window.addEventListener("load", fitToViewport);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(fitToViewport).observe(document.documentElement);
  }
  setTimeout(fitToViewport, 0);
  setTimeout(fitToViewport, 120);
  setTimeout(fitToViewport, 500);
  window.__LINKYUN_APPLET__ = Object.freeze({
    emit(event, payload) {
      window.parent.postMessage({ type: "APP_EVENT", event, payload: payload ?? null }, "*");
    }
  });
  window.addEventListener("message", (ev) => {
    const msg = ev.data || {};
    if (msg.type === "AGENT_EVENT") {
      window.dispatchEvent(new CustomEvent("linkyun:agent-event", { detail: msg }));
      return;
    }
    if (msg.type === "HOT_PATCH" && msg.patchType === "css" && typeof msg.content === "string") {
      let style = document.getElementById("linkyun-hot-css");
      if (!style) {
        style = document.createElement("style");
        style.id = "linkyun-hot-css";
        document.head.appendChild(style);
      }
      style.textContent = msg.content;
      return;
    }
    if (msg.type === "HOT_PATCH" && msg.patchType === "state") {
      window.dispatchEvent(new CustomEvent("linkyun:state-patch", { detail: msg.content }));
    }
  });
})();
</script>`
  let out = html
  out = /<head[^>]*>/i.test(out)
    ? out.replace(/<head([^>]*)>/i, `<head$1>${meta}`)
    : `${meta}${out}`
  out = /<\/body>/i.test(out)
    ? out.replace(/<\/body>/i, `${bridge}</body>`)
    : `${out}${bridge}`
  return out
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}
