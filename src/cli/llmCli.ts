import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { loadConfig, saveProjectConfig, ConfigError } from '../config/io.js'
import type { InfinitiConfig, LlmProfile, LlmProvider } from '../config/types.js'
import {
  ADD_LLM_DEFAULT_BASE,
  fetchModelsForProvider,
} from './llmModelFetch.js'

type AddProvider = 'openai' | 'anthropic' | 'gemini' | 'openrouter'

function ensureProfiles(cfg: InfinitiConfig): InfinitiConfig {
  if (cfg.llm.profiles && Object.keys(cfg.llm.profiles).length > 0) {
    return cfg
  }
  const name = 'main'
  const p: LlmProfile = {
    provider: cfg.llm.provider,
    baseUrl: cfg.llm.baseUrl,
    model: cfg.llm.model,
    apiKey: cfg.llm.apiKey,
  }
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      default: cfg.llm.default ?? name,
      profiles: { [name]: p },
    },
  }
}

function syncTopLevelFromDefault(cfg: InfinitiConfig): InfinitiConfig {
  const profiles = cfg.llm.profiles
  const defName = cfg.llm.default ?? Object.keys(profiles ?? {})[0]
  if (!defName || !profiles?.[defName]) return cfg
  const p = profiles[defName]
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      default: defName,
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: p.apiKey,
    },
  }
}

async function createRl(): Promise<readline.Interface> {
  return readline.createInterface({ input, output })
}

export async function runAddLlm(
  cwd: string,
  opts: { profile?: string; provider?: AddProvider } = {},
): Promise<void> {
  let cfg: InfinitiConfig
  try {
    cfg = ensureProfiles(await loadConfig(cwd))
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exitCode = 2
      return
    }
    throw e
  }

  const rl = await createRl()
  try {
    console.error('\n=== infiniti-agent add_llm — 写入项目 .infiniti-agent/config.json ===\n')
    const pmap: AddProvider[] = ['openai', 'anthropic', 'gemini', 'openrouter']
    let choice: AddProvider | undefined = opts.provider
    if (!choice) {
      console.error('选择提供商（输入数字）:')
      console.error('  1) OpenAI')
      console.error('  2) Anthropic')
      console.error('  3) Google Gemini')
      console.error('  4) OpenRouter（OpenAI 兼容）')
      const pRaw = await rl.question('> ')
      const pNum = Number(pRaw.trim())
      if (!Number.isFinite(pNum) || pNum < 1 || pNum > 4) {
        console.error('无效选择')
        process.exitCode = 2
        return
      }
      choice = pmap[pNum - 1]!
    } else {
      console.error(`提供商: ${choice}（来自 --provider）`)
    }

    const defBase = ADD_LLM_DEFAULT_BASE[choice]
    console.error(`\n默认 baseUrl: ${defBase}`)
    const baseAns = (await rl.question('按 Enter 使用默认，或粘贴自定义 baseUrl: ')).trim()
    const baseUrl = baseAns || defBase

    const keyPrompt =
      choice === 'gemini'
        ? '请输入 Google AI Studio / Gemini API Key: '
        : '请输入 API Key（输入时可见，粘贴后 Enter）: '
    const apiKey = (await rl.question(keyPrompt)).trim()
    if (!apiKey) {
      console.error('API Key 不能为空')
      process.exitCode = 2
      return
    }

    console.error('\n正在拉取模型列表…')
    let models: string[] = []
    try {
      models = await fetchModelsForProvider(choice, baseUrl, apiKey)
    } catch (e) {
      console.error((e as Error).message)
      const manual = (await rl.question('是否改为手动输入模型 id？(y/N): ')).trim().toLowerCase()
      if (manual !== 'y' && manual !== 'yes') {
        process.exitCode = 2
        return
      }
    }

    let model = ''
    if (models.length > 0) {
      const cap = Math.min(models.length, 80)
      console.error(`\n可选模型（共 ${models.length}，显示前 ${cap} 个）：`)
      for (let i = 0; i < cap; i++) {
        console.error(`  ${i + 1}. ${models[i]}`)
      }
      const pick = (await rl.question('\n输入序号，或直接输入模型 id: ')).trim()
      const n = Number(pick)
      if (Number.isFinite(n) && n >= 1 && n <= cap) {
        model = models[n - 1]!
      } else if (pick) {
        model = pick
      }
    }
    if (!model) {
      model = (await rl.question('请输入模型 id: ')).trim()
    }
    if (!model) {
      console.error('模型不能为空')
      process.exitCode = 2
      return
    }

    const storeProvider: LlmProvider =
      choice === 'openrouter' ? 'openrouter' : choice

    let profileName =
      opts.profile?.trim() ||
      (await rl.question('\nProfile 名称（用于 select_llm，默认 main）: ')).trim() ||
      'main'

    const existing = cfg.llm.profiles?.[profileName]
    if (existing) {
      const ok = (await rl.question(`已存在 profile「${profileName}」，覆盖？(y/N): `))
        .trim()
        .toLowerCase()
      if (ok !== 'y' && ok !== 'yes') {
        profileName =
          (await rl.question('请输入新的 profile 名称: ')).trim() || `profile-${Date.now()}`
      }
    }

    const profile: LlmProfile = {
      provider: storeProvider,
      baseUrl: baseUrl.trim(),
      model,
      apiKey,
    }

    const profiles = { ...(cfg.llm.profiles ?? {}), [profileName]: profile }
    let defaultName = cfg.llm.default
    if (!defaultName || !profiles[defaultName]) {
      defaultName = profileName
    } else {
      const setDef = (
        await rl.question(`\n将「${profileName}」设为当前默认 LLM？(Y/n): `)
      )
        .trim()
        .toLowerCase()
      if (setDef !== 'n' && setDef !== 'no') {
        defaultName = profileName
      }
    }

    const next: InfinitiConfig = syncTopLevelFromDefault({
      ...cfg,
      llm: {
        ...cfg.llm,
        default: defaultName,
        profiles,
      },
    })

    await saveProjectConfig(cwd, next)
    console.error(`\n已写入 ${cwd}/.infiniti-agent/config.json`)
    console.error(`Profile「${profileName}」(${storeProvider} / ${model})，当前默认: ${next.llm.default}`)
    const allNames = Object.keys(next.llm.profiles ?? {})
    console.error(`共 ${allNames.length} 个 profile: ${allNames.join(', ')}`)
  } finally {
    rl.close()
  }
}

export async function runSelectLlm(cwd: string, opts: { name?: string }): Promise<void> {
  let cfg: InfinitiConfig
  try {
    cfg = ensureProfiles(await loadConfig(cwd))
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exitCode = 2
      return
    }
    throw e
  }

  const profiles = cfg.llm.profiles!
  const names = Object.keys(profiles).sort()
  if (names.length === 0) {
    console.error('没有可用的 LLM profile，请先 add_llm')
    process.exitCode = 2
    return
  }

  let pick = opts.name?.trim()
  if (!pick) {
    const rl = await createRl()
    try {
      console.error('\n=== infiniti-agent select_llm ===\n')
      names.forEach((n, i) => {
        const p = profiles[n]!
        console.error(`  ${i + 1}. ${n}  (${p.provider} / ${p.model})`)
      })
      pick = (await rl.question('\n输入 profile 名称或序号: ')).trim()
    } finally {
      rl.close()
    }
  }

  if (!pick) {
    console.error('未选择 profile')
    process.exitCode = 2
    return
  }

  const n = Number(pick)
  let name: string | undefined
  if (Number.isFinite(n) && n >= 1 && n <= names.length) {
    name = names[n - 1]
  } else if (profiles[pick]) {
    name = pick
  }

  if (!name) {
    console.error(`未找到 profile: ${pick}`)
    process.exitCode = 2
    return
  }

  const next = syncTopLevelFromDefault({
    ...cfg,
    llm: {
      ...cfg.llm,
      default: name,
      profiles,
    },
  })

  await saveProjectConfig(cwd, next)
  console.error(`已切换默认 LLM 为「${name}」（${profiles[name].provider} / ${profiles[name].model}）`)
  console.error(`已写入 ${cwd}/.infiniti-agent/config.json`)
}
