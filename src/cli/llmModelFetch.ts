/** add_llm 使用的厂商默认 baseUrl（与 defaults.ts 对齐，可在此处单独覆盖说明） */
export const ADD_LLM_DEFAULT_BASE: Record<
  'openai' | 'anthropic' | 'gemini' | 'openrouter',
  string
> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '')
}

/** 若 baseUrl 已含 /v1 则只追加 /models，否则追加 /v1/models */
function openAiCompatibleModelsUrl(baseUrl: string): string {
  const r = stripTrailingSlash(baseUrl)
  if (r.endsWith('/v1')) return `${r}/models`
  return `${r}/v1/models`
}

function anthropicModelsUrl(baseUrl: string): string {
  const r = stripTrailingSlash(baseUrl)
  if (r.endsWith('/v1')) return `${r}/models`
  return `${r}/v1/models`
}

/** OpenAI 兼容：OpenAI / OpenRouter 等 GET …/models */
export async function fetchOpenAiCompatibleModelIds(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const url = openAiCompatibleModelsUrl(baseUrl)
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`拉取模型列表失败 (${res.status}): ${text.slice(0, 400)}`)
  }
  let j: unknown
  try {
    j = JSON.parse(text) as { data?: Array<{ id?: string }> }
  } catch {
    throw new Error('模型列表响应不是合法 JSON')
  }
  const data = (j as { data?: unknown }).data
  if (!Array.isArray(data)) {
    throw new Error('模型列表格式异常：缺少 data 数组')
  }
  const ids = data
    .map((x) => (x && typeof x === 'object' ? (x as { id?: string }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const filtered = ids.filter(
    (id) =>
      !id.includes('embedding') &&
      !id.includes('moderation') &&
      !id.includes('babbage') &&
      !id.includes('davinci'),
  )
  return [...new Set(filtered.length ? filtered : ids)].sort()
}

/** Anthropic GET …/v1/models */
export async function fetchAnthropicModelIds(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const url = anthropicModelsUrl(baseUrl)
  const res = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`拉取模型列表失败 (${res.status}): ${text.slice(0, 400)}`)
  }
  let j: unknown
  try {
    j = JSON.parse(text) as { data?: Array<{ id?: string }> }
  } catch {
    throw new Error('模型列表响应不是合法 JSON')
  }
  const data = (j as { data?: unknown }).data
  if (!Array.isArray(data)) {
    throw new Error('模型列表格式异常：缺少 data 数组')
  }
  const ids = data
    .map((x) => (x && typeof x === 'object' ? (x as { id?: string }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set(ids)].sort()
}

/** Gemini：ListModels，仅保留支持 generateContent 的模型 */
export async function fetchGeminiModelIds(apiKey: string): Promise<string[]> {
  const base = ADD_LLM_DEFAULT_BASE.gemini
  const url = `${stripTrailingSlash(base)}/models?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`拉取模型列表失败 (${res.status}): ${text.slice(0, 400)}`)
  }
  const j = JSON.parse(text) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>
  }
  const models = j.models ?? []
  const out: string[] = []
  for (const m of models) {
    const methods = m.supportedGenerationMethods ?? []
    if (!methods.includes('generateContent')) continue
    const name = m.name
    if (typeof name !== 'string' || !name.startsWith('models/')) continue
    out.push(name.replace(/^models\//, ''))
  }
  return [...new Set(out)].sort()
}

export async function fetchModelsForProvider(
  provider: 'openai' | 'anthropic' | 'gemini' | 'openrouter',
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  if (provider === 'gemini') {
    return fetchGeminiModelIds(apiKey)
  }
  if (provider === 'anthropic') {
    return fetchAnthropicModelIds(baseUrl, apiKey)
  }
  return fetchOpenAiCompatibleModelIds(baseUrl, apiKey)
}
