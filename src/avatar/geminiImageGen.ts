/**
 * Gemini native image generation/editing via generateContent.
 * @see https://ai.google.dev/gemini-api/docs/image-generation
 */

export type GeminiRefImage = {
  mimeType: string
  base64: string
}

export type GeminiImageGenOptions = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  referenceImages?: GeminiRefImage[]
  aspectRatio?: string
  imageSize?: string
  timeoutMs?: number
}

function geminiPartImageData(part: unknown): string | undefined {
  if (!part || typeof part !== 'object') return undefined
  const p = part as {
    inlineData?: { data?: unknown }
    inline_data?: { data?: unknown }
  }
  const data = p.inlineData?.data ?? p.inline_data?.data
  return typeof data === 'string' && data.trim() ? data : undefined
}

export async function geminiGenerateImageBuffer(opts: GeminiImageGenOptions): Promise<Buffer> {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const model = opts.model.startsWith('models/') ? opts.model.slice('models/'.length) : opts.model
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`

  const parts: unknown[] = [{ text: opts.prompt }]
  for (const img of opts.referenceImages ?? []) {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64,
      },
    })
  }

  const generationConfig: Record<string, unknown> = {
    responseModalities: ['IMAGE'],
  }
  if (opts.aspectRatio || opts.imageSize) {
    generationConfig.imageConfig = {
      ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}),
      ...(opts.imageSize ? { imageSize: opts.imageSize } : {}),
    }
  }

  const key = opts.apiKey.trim()
  if (!key) throw new Error('Gemini: apiKey 为空，无法设置 x-goog-api-key')

  const ac = new AbortController()
  const timer = opts.timeoutMs && opts.timeoutMs > 0
    ? setTimeout(() => ac.abort(), opts.timeoutMs)
    : undefined
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig,
    }),
    signal: ac.signal,
  }).finally(() => {
    if (timer) clearTimeout(timer)
  })

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const err = json && typeof json.error === 'object' && json.error && typeof (json.error as { message?: string }).message === 'string'
      ? (json.error as { message: string }).message
      : `HTTP ${res.status}`
    throw new Error(`Gemini 图像生成失败: ${err}`)
  }

  const candidates = json?.candidates as unknown[] | undefined
  const first = candidates?.[0]
  const content = first && typeof first === 'object' ? (first as { content?: { parts?: unknown[] } }).content : undefined
  for (const part of content?.parts ?? []) {
    const data = geminiPartImageData(part)
    if (data) return Buffer.from(data, 'base64')
  }
  throw new Error('Gemini 响应中无 inlineData 图像')
}
