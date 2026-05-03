import React, { useState } from 'react'
import { Box, Text, useApp, useWindowSize } from 'ink'
import SelectInput from 'ink-select-input'
import { PROVIDER_DEFAULTS } from '../config/defaults.js'
import type { LlmProvider, LlmProfile } from '../config/types.js'
import { saveConfig } from '../config/io.js'
import { StableTextInput } from './StableTextInput.js'

type Step =
  | 'profileName'
  | 'provider'
  | 'baseUrl'
  | 'model'
  | 'apiKey'
  | 'askMore'
  | 'done'

const providerItems: { label: string; value: LlmProvider }[] = [
  { label: 'Anthropic (Claude)', value: 'anthropic' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Google Gemini', value: 'gemini' },
  { label: 'MiniMax (M2.7)', value: 'minimax' },
  { label: 'OpenRouter', value: 'openrouter' },
]

const yesNoItems = [
  { label: '是 — 继续添加', value: 'yes' },
  { label: '否 — 完成配置', value: 'no' },
]

export function InitWizard(): React.ReactElement {
  const { exit } = useApp()
  const { columns } = useWindowSize()

  const [profiles, setProfiles] = useState<Record<string, LlmProfile>>({})
  const [defaultProfile, setDefaultProfile] = useState<string>('main')

  const [step, setStep] = useState<Step>('profileName')
  const [currentName, setCurrentName] = useState('main')
  const [provider, setProvider] = useState<LlmProvider>('anthropic')
  const [baseUrl, setBaseUrl] = useState(PROVIDER_DEFAULTS.anthropic.baseUrl)
  const [model, setModel] = useState(PROVIDER_DEFAULTS.anthropic.model)
  const [apiKey, setApiKey] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const profileCount = Object.keys(profiles).length

  const resetForNewProfile = () => {
    setCurrentName('')
    setProvider('anthropic')
    setBaseUrl(PROVIDER_DEFAULTS.anthropic.baseUrl)
    setModel(PROVIDER_DEFAULTS.anthropic.model)
    setApiKey('')
    setErr(null)
  }

  const applyProviderDefaults = (p: LlmProvider) => {
    const d = PROVIDER_DEFAULTS[p]
    setBaseUrl(d.baseUrl)
    setModel(d.model)
  }

  const finishCurrentProfile = () => {
    const profile: LlmProfile = {
      provider,
      baseUrl: baseUrl.trim() || PROVIDER_DEFAULTS[provider].baseUrl,
      model: model.trim() || PROVIDER_DEFAULTS[provider].model,
      apiKey: apiKey.trim(),
    }
    const name = currentName.trim() || `profile${profileCount + 1}`
    setProfiles((prev) => ({ ...prev, [name]: profile }))
    if (profileCount === 0) {
      setDefaultProfile(name)
    }
    return name
  }

  if (step === 'done') {
    const names = Object.keys(profiles)
    return (
      <Box flexDirection="column">
        <Text color="green">配置已写入 ~/.infiniti-agent/config.json</Text>
        <Text dimColor>
          已配置 {names.length} 个 LLM profile：{names.join(', ')}
          （默认：{defaultProfile}）
        </Text>
        <Text dimColor>运行 infiniti-agent 进入对话，或 infiniti-agent migrate 初始化项目。</Text>
      </Box>
    )
  }

  if (step === 'profileName') {
    const hint = profileCount === 0
      ? '第一个 profile 将作为默认主模型（建议命名 main）'
      : `已有 ${profileCount} 个 profile，可添加 gate（安全评估）/ compact（压缩）/ fast（辅助）等`
    const placeholder = profileCount === 0 ? 'main' : ''
    return (
      <Box flexDirection="column">
        <Text bold>Infiniti Agent — LLM 配置 ({profileCount + 1})</Text>
        <Text dimColor>{hint}</Text>
        {err ? <Text color="red">{err}</Text> : null}
        <Box>
          <StableTextInput
            value={currentName}
            placeholder={placeholder}
            onChange={setCurrentName}
            onSubmit={(v) => {
              const name = v.trim() || (profileCount === 0 ? 'main' : '')
              if (!name) {
                setErr('名称不能为空')
                return
              }
              if (profiles[name]) {
                setErr(`"${name}" 已存在，请换一个名称`)
                return
              }
              setCurrentName(name)
              setStep('provider')
              setErr(null)
            }}
            columns={columns}
            prefix="Profile 名称 > "
          />
        </Box>
      </Box>
    )
  }

  if (step === 'provider') {
    return (
      <Box flexDirection="column">
        <Text bold>[{currentName}] 选择提供商</Text>
        <Text dimColor>方向键 + 回车</Text>
        {err ? <Text color="red">{err}</Text> : null}
        <SelectInput
          items={providerItems}
          onSelect={(item) => {
            setProvider(item.value)
            applyProviderDefaults(item.value)
            setStep('baseUrl')
            setErr(null)
          }}
        />
      </Box>
    )
  }

  if (step === 'baseUrl') {
    return (
      <Box flexDirection="column">
        <Text bold>[{currentName}] Base URL</Text>
        <Text dimColor>默认: {PROVIDER_DEFAULTS[provider].baseUrl}</Text>
        {err ? <Text color="red">{err}</Text> : null}
        <Box>
          <StableTextInput
            value={baseUrl}
            onChange={setBaseUrl}
            onSubmit={(v) => {
              const u = v.trim() || PROVIDER_DEFAULTS[provider].baseUrl
              setBaseUrl(u)
              setStep('model')
              setErr(null)
            }}
            columns={columns}
            prefix="> "
          />
        </Box>
        <Text dimColor>回车确认；留空则使用上方默认</Text>
      </Box>
    )
  }

  if (step === 'model') {
    return (
      <Box flexDirection="column">
        <Text bold>[{currentName}] Model ID</Text>
        <Text dimColor>默认: {PROVIDER_DEFAULTS[provider].model}</Text>
        {err ? <Text color="red">{err}</Text> : null}
        <Box>
          <StableTextInput
            value={model}
            onChange={setModel}
            onSubmit={(v) => {
              const m = v.trim() || PROVIDER_DEFAULTS[provider].model
              setModel(m)
              setStep('apiKey')
              setErr(null)
            }}
            columns={columns}
            prefix="> "
          />
        </Box>
      </Box>
    )
  }

  if (step === 'apiKey') {
    return (
      <Box flexDirection="column">
        <Text bold>[{currentName}] API Key</Text>
        <Text dimColor>将写入 ~/.infiniti-agent/config.json（文件权限仅本人可读）</Text>
        {err ? <Text color="red">{err}</Text> : null}
        <Box>
          <StableTextInput
            value={apiKey}
            onChange={setApiKey}
            onSubmit={(v) => {
              const k = v.trim()
              if (!k) {
                setErr('API Key 不能为空')
                return
              }
              setApiKey(k)
              finishCurrentProfile()
              setStep('askMore')
              setErr(null)
            }}
            columns={columns}
            prefix="> "
          />
        </Box>
      </Box>
    )
  }

  // askMore
  const allNames = Object.keys(profiles)
  return (
    <Box flexDirection="column">
      <Text bold>已配置：{allNames.join(', ')}</Text>
      <Text dimColor>是否继续添加更多 LLM profile？（如 gate / compact / fast）</Text>
      <SelectInput
        items={yesNoItems}
        onSelect={async (item) => {
          if (item.value === 'yes') {
            resetForNewProfile()
            setStep('profileName')
          } else {
            try {
              await saveConfig({
                profiles,
                defaultProfile,
              })
              setStep('done')
              setTimeout(() => exit(), 400)
            } catch (e: unknown) {
              setErr(e instanceof Error ? e.message : String(e))
            }
          }
        }}
      />
    </Box>
  )
}
