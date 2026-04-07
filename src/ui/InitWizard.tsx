import React, { useState } from 'react'
import { Box, Text, useApp } from 'ink'
import SelectInput from 'ink-select-input'
import TextInput from 'ink-text-input'
import { PROVIDER_DEFAULTS } from '../config/defaults.js'
import type { LlmProvider } from '../config/types.js'
import { saveConfig } from '../config/io.js'

type Step = 'provider' | 'baseUrl' | 'model' | 'apiKey' | 'done'

const providerItems: { label: string; value: LlmProvider }[] = [
  { label: 'Anthropic (Claude)', value: 'anthropic' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Google Gemini', value: 'gemini' },
]

export function InitWizard(): React.ReactElement {
  const { exit } = useApp()
  const [step, setStep] = useState<Step>('provider')
  const [provider, setProvider] = useState<LlmProvider>('anthropic')
  const [baseUrl, setBaseUrl] = useState(PROVIDER_DEFAULTS.anthropic.baseUrl)
  const [model, setModel] = useState(PROVIDER_DEFAULTS.anthropic.model)
  const [apiKey, setApiKey] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const applyProviderDefaults = (p: LlmProvider) => {
    const d = PROVIDER_DEFAULTS[p]
    setBaseUrl(d.baseUrl)
    setModel(d.model)
  }

  if (step === 'done') {
    return (
      <Box flexDirection="column">
        <Text color="green">配置已写入 ~/.infiniti-agent/config.json</Text>
        <Text dimColor>运行 infiniti-agent 进入对话。</Text>
      </Box>
    )
  }

  if (step === 'provider') {
    return (
      <Box flexDirection="column">
        <Text bold>Infiniti Agent — LLM 配置</Text>
        <Text dimColor>选择提供商（方向键 + 回车）</Text>
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
        <Text bold>Base URL</Text>
        <Text dimColor>默认: {PROVIDER_DEFAULTS[provider].baseUrl}</Text>
        {err ? <Text color="red">{err}</Text> : null}
        <Box>
          <Text>&gt; </Text>
          <TextInput
            value={baseUrl}
            onChange={setBaseUrl}
            onSubmit={(v) => {
              const u = v.trim() || PROVIDER_DEFAULTS[provider].baseUrl
              setBaseUrl(u)
              setStep('model')
              setErr(null)
            }}
          />
        </Box>
        <Text dimColor>回车确认；留空则使用上方默认</Text>
      </Box>
    )
  }

  if (step === 'model') {
    return (
      <Box flexDirection="column">
        <Text bold>Model ID</Text>
        <Text dimColor>默认: {PROVIDER_DEFAULTS[provider].model}</Text>
        {err ? <Text color="red">{err}</Text> : null}
        <Box>
          <Text>&gt; </Text>
          <TextInput
            value={model}
            onChange={setModel}
            onSubmit={(v) => {
              const m = v.trim() || PROVIDER_DEFAULTS[provider].model
              setModel(m)
              setStep('apiKey')
              setErr(null)
            }}
          />
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>API Key</Text>
      <Text dimColor>将写入 ~/.infiniti-agent/config.json（建议文件权限仅本人可读）</Text>
      {err ? <Text color="red">{err}</Text> : null}
      <Box>
        <Text>&gt; </Text>
        <TextInput
          value={apiKey}
          onChange={setApiKey}
          onSubmit={async (v) => {
            const k = v.trim()
            if (!k) {
              setErr('API Key 不能为空')
              return
            }
            try {
              await saveConfig({
                provider,
                baseUrl: baseUrl.trim() || PROVIDER_DEFAULTS[provider].baseUrl,
                model: model.trim() || PROVIDER_DEFAULTS[provider].model,
                apiKey: k,
              })
              setStep('done')
              setTimeout(() => exit(), 400)
            } catch (e: unknown) {
              setErr(e instanceof Error ? e.message : String(e))
            }
          }}
        />
      </Box>
    </Box>
  )
}
