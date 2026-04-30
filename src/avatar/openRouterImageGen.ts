/**
 * OpenRouter Chat Completions + modalities image（Gemini Flash Image / Seedream 等）。
 * @see https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 */

export type OpenRouterRefImage = {
  mimeType: string
  base64: string
}

export type OpenRouterImageGenOptions = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  referenceImages?: OpenRouterRefImage[]
  modalities?: ('text' | 'image')[]
  aspectRatio?: string
  imageSize?: string
  quality?: 'auto' | 'high' | 'medium' | 'low'
  transparentBackground?: boolean
  timeoutMs?: number
}

function decodeDataUrlImage(dataUrl: string): Buffer {
  const s = dataUrl.trim()
  const m = s.match(/^data:([^;]+);base64,(.+)$/is)
  if (!m) throw new Error('图像响应不是 data URL base64')
  return Buffer.from(m[2]!, 'base64')
}

export async function openRouterGenerateImageBuffer(opts: OpenRouterImageGenOptions): Promise<Buffer> {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const url = `${base}/chat/completions`
  const modalities = opts.modalities ?? ['image', 'text']

  const content: unknown[] = []
  for (const img of opts.referenceImages ?? []) {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
      },
    })
  }
  content.push({ type: 'text', text: opts.prompt })

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [{ role: 'user', content }],
    modalities,
    stream: false,
  }
  if (opts.aspectRatio || opts.imageSize || opts.quality || opts.transparentBackground) {
    body.image_config = {
      ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
      ...(opts.imageSize ? { image_size: opts.imageSize } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
      ...(opts.transparentBackground ? { background: 'transparent', output_format: 'png' } : {}),
    }
  }

  const key = opts.apiKey.trim()
  if (!key) throw new Error('OpenRouter: apiKey 为空，无法设置 Authorization')

  const ac = new AbortController()
  const timer = opts.timeoutMs && opts.timeoutMs > 0
    ? setTimeout(() => ac.abort(), opts.timeoutMs)
    : undefined
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/stelee410/infiniti-agent',
      'X-Title': 'infiniti-agent',
    },
    body: JSON.stringify(body),
    signal: ac.signal,
  }).finally(() => {
    if (timer) clearTimeout(timer)
  })

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const err = json && typeof json.error === 'object' && json.error && typeof (json.error as { message?: string }).message === 'string'
      ? (json.error as { message: string }).message
      : `HTTP ${res.status}`
    throw new Error(`OpenRouter 图像生成失败: ${err}`)
  }

  const choices = json?.choices as unknown[] | undefined
  const msg = choices?.[0] && typeof choices[0] === 'object' ? (choices[0] as { message?: unknown }).message : undefined
  const m = msg && typeof msg === 'object' ? (msg as Record<string, unknown>) : null
  const images = m?.images as unknown[] | undefined
  const first = images?.[0]
  if (!first || typeof first !== 'object') {
    throw new Error('OpenRouter 响应中无 images，请确认 model 支持 output_modalities 含 image，并已传 modalities')
  }
  const iu = (first as { image_url?: { url?: string } }).image_url?.url
  if (typeof iu !== 'string' || !iu.startsWith('data:')) {
    throw new Error('OpenRouter 图像字段格式异常')
  }
  return decodeDataUrlImage(iu)
}
