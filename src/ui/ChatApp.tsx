import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { join } from 'node:path'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import chokidar from 'chokidar'
import type { InfinitiConfig } from '../config/types.js'
import { loadSkillsForConfig, skillsToSystemBlock } from '../skills/loader.js'
import { readMemoryForPrompt } from '../memory/store.js'
import {
  loadAgentPromptDocs,
  formatSystemFromDocs,
} from '../prompt/loadProjectPrompt.js'
import { runToolLoop } from '../llm/runLoop.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { saveSession, loadSession } from '../session/file.js'
import { SKILLS_DIR } from '../paths.js'
import type { McpManager } from '../mcp/manager.js'
import { loadConfig } from '../config/io.js'
import { formatChatError } from '../utils/formatError.js'
import {
  buildSlashItems,
  filterSlashItems,
  type SlashItem,
} from './slashCompletions.js'

type Props = {
  config: InfinitiConfig
  mcp: McpManager
}

const STREAM_DEBOUNCE_MS = 48
const SLASH_MENU_MAX_ROWS = 10

export function ChatApp({ config: initialConfig, mcp }: Props): React.ReactElement {
  const { exit } = useApp()
  const rows = process.stdout.rows ?? 24
  const [config, setConfig] = useState(initialConfig)
  const [cwd, setCwd] = useState(process.cwd())
  const [messages, setMessages] = useState<PersistedMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [skillsEpoch, setSkillsEpoch] = useState(0)
  const [promptEpoch, setPromptEpoch] = useState(0)
  const [sessionReady, setSessionReady] = useState(false)
  const [streamText, setStreamText] = useState('')
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [slashIndex, setSlashIndex] = useState(0)

  const slashItems = useMemo(
    () => buildSlashItems(mcp),
    [mcp, config],
  )

  const slashFiltered = useMemo(
    () => filterSlashItems(slashItems, input),
    [slashItems, input],
  )

  const slashMenuOpen =
    sessionReady &&
    !busy &&
    input.startsWith('/') &&
    !input.includes(' ')

  useEffect(() => {
    setSlashIndex(0)
  }, [input])

  useInput(
    (_ch, key) => {
      if (!slashMenuOpen) {
        return
      }
      const list = slashFiltered
      if (key.tab) {
        if (list.length === 0) {
          return
        }
        const idx =
          ((slashIndex % list.length) + list.length) % list.length
        const item = list[idx]!
        const ins = item.insert.endsWith(' ') ? item.insert : `${item.insert} `
        setInput(ins)
        return
      }
      if (key.upArrow) {
        if (list.length === 0) {
          return
        }
        setSlashIndex((i) => (i - 1 + list.length) % list.length)
        return
      }
      if (key.downArrow) {
        if (list.length === 0) {
          return
        }
        setSlashIndex((i) => (i + 1) % list.length)
      }
    },
    { isActive: slashMenuOpen },
  )

  const flushStream = useCallback((full: string) => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current)
    }
    streamTimerRef.current = setTimeout(() => {
      setStreamText(full)
    }, STREAM_DEBOUNCE_MS)
  }, [])

  const resetStream = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current)
      streamTimerRef.current = undefined
    }
    setStreamText('')
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const s = await loadSession()
        if (s?.messages?.length) {
          setMessages(s.messages)
          setCwd(s.cwd || process.cwd())
        }
      } finally {
        setSessionReady(true)
      }
    })()
  }, [])

  useEffect(() => {
    const w = chokidar.watch(SKILLS_DIR, {
      ignoreInitial: true,
      persistent: true,
    })
    const bump = (): void => {
      setSkillsEpoch((n) => n + 1)
    }
    w.on('add', bump).on('change', bump).on('unlink', bump)
    return () => {
      void w.close()
    }
  }, [])

  useEffect(() => {
    const paths = [join(cwd, 'SOUL.md'), join(cwd, 'INFINITI.md')]
    const w = chokidar.watch(paths, {
      ignoreInitial: true,
      persistent: true,
    })
    const bump = (): void => {
      setPromptEpoch((n) => n + 1)
    }
    w.on('add', bump).on('change', bump).on('unlink', bump)
    return () => {
      void w.close()
    }
  }, [cwd])

  const buildSystem = useCallback(async (): Promise<string> => {
    const mem = await readMemoryForPrompt()
    const skills = await loadSkillsForConfig(config)
    void skillsEpoch
    void promptEpoch
    const docs = await loadAgentPromptDocs(cwd)
    const skillBlock = skillsToSystemBlock(skills)
    const parts = [formatSystemFromDocs(docs)]
    if (mem.trim()) {
      parts.push(`## 长期记忆（来自 ~/.infiniti-agent/memory.md）\n\n${mem}`)
    }
    if (skillBlock.trim()) {
      parts.push(skillBlock)
    }
    return parts.join('\n\n')
  }, [config, cwd, skillsEpoch, promptEpoch])

  const reloadAll = useCallback(async () => {
    try {
      const next = await loadConfig()
      setConfig(next)
      await mcp.stop()
      await mcp.start(next)
      setError(null)
    } catch (e: unknown) {
      setError(formatChatError(e))
    }
  }, [mcp])

  const handleSubmit = useCallback(
    async (line: string) => {
      const raw = line.trimEnd()
      if (!raw.trim()) {
        return
      }
      if (!sessionReady) {
        return
      }

      if (raw === '/exit' || raw === '/quit') {
        await saveSession(cwd, messages)
        exit()
        return
      }
      if (raw === '/clear') {
        setMessages([])
        await saveSession(cwd, [])
        setInput('')
        return
      }
      if (raw === '/reload' || raw === '/reload-skills') {
        await reloadAll()
        setInput('')
        return
      }
      if (raw === '/memory') {
        setError('长期记忆文件: ~/.infiniti-agent/memory.md')
        setInput('')
        return
      }
      if (raw === '/help') {
        setError(
          '输入 / 可补全：斜杠命令与全部工具（↑↓ Tab）。命令: /exit /clear /reload /memory — 其余发给模型（SSE）',
        )
        setInput('')
        return
      }

      setBusy(true)
      setError(null)
      resetStream()
      const userLine = raw
      const nextMsgs: PersistedMessage[] = [
        ...messages,
        { role: 'user', content: userLine },
      ]
      setMessages(nextMsgs)
      setInput('')
      try {
        const system = await buildSystem()
        const { messages: out } = await runToolLoop({
          config,
          system,
          messages: nextMsgs,
          cwd,
          mcp,
          stream: {
            onStreamReset: resetStream,
            onTextDelta: (_delta, full) => {
              flushStream(full)
            },
          },
        })
        setMessages(out)
        await saveSession(cwd, out)
      } catch (e: unknown) {
        setError(formatChatError(e))
      } finally {
        resetStream()
        setBusy(false)
      }
    },
    [
      buildSystem,
      config,
      cwd,
      exit,
      flushStream,
      mcp,
      messages,
      reloadAll,
      resetStream,
      sessionReady,
    ],
  )

  const visibleCount = Math.max(4, rows - 14)
  const visible = messages.slice(-visibleCount)
  const meta = `${config.llm.provider} · ${config.llm.model}`

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        paddingY={0}
        marginBottom={1}
        flexDirection="column"
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="cyan">
            ∞ Infiniti Agent
          </Text>
          <Text dimColor>SSE</Text>
        </Box>
        <Text dimColor>
          {meta}
        </Text>
        <Text dimColor wrap="truncate">
          cwd: {cwd}
        </Text>
      </Box>

      <Text dimColor>
        输入 / 补全命令与工具 · ↑↓ Tab · SOUL/INFINITI/Skills 热重载
      </Text>

      {error ? (
        <Box marginY={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}

      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        paddingY={1}
        marginTop={1}
        flexDirection="column"
        minHeight={6}
      >
        {visible.map((m, i) => (
          <MessageLine key={`${i}-${m.role}`} m={m} />
        ))}
        {streamText ? (
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="single"
            borderLeft
            borderLeftColor="magenta"
            paddingLeft={1}
          >
            <Text bold color="magenta">
              Assistant · 流式
            </Text>
            <Text dimColor wrap="wrap">
              {streamText}
            </Text>
          </Box>
        ) : null}
      </Box>

      {!sessionReady ? (
        <Box marginTop={1}>
          <Text dimColor>正在加载会话…</Text>
        </Box>
      ) : null}
      {busy ? (
        <Box marginTop={1}>
          <Text color="yellow">
            ◆ 请求中（Anthropic/OpenAI/Gemini 均走流式 SSE）…
          </Text>
        </Box>
      ) : null}

      {slashMenuOpen ? (
        <SlashCompletePanel
          items={slashFiltered}
          selectedIndex={slashIndex}
        />
      ) : null}

      <Box marginTop={1} borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text color="cyan" bold>
          ›{' '}
        </Text>
        <TextInput
          value={input}
          focus={!busy && sessionReady}
          onChange={setInput}
          onSubmit={(v) => {
            if (!busy) {
              void handleSubmit(v)
            }
          }}
          placeholder="输入…"
        />
      </Box>
    </Box>
  )
}

function SlashCompletePanel({
  items,
  selectedIndex,
}: {
  items: SlashItem[]
  selectedIndex: number
}): React.ReactElement {
  const total = items.length
  const sel = total > 0 ? ((selectedIndex % total) + total) % total : 0
  let start = 0
  if (total > SLASH_MENU_MAX_ROWS) {
    start = Math.max(
      0,
      Math.min(sel - Math.floor(SLASH_MENU_MAX_ROWS / 2), total - SLASH_MENU_MAX_ROWS),
    )
  }
  const visible = items.slice(start, start + SLASH_MENU_MAX_ROWS)

  return (
    <Box
      marginTop={1}
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      paddingY={1}
    >
      <Text bold color="yellow">
        / 补全
      </Text>
      <Text dimColor>
        ↑↓ 选择 · Tab 写入 · 共 {total} 项
        {total > SLASH_MENU_MAX_ROWS
          ? `（显示 ${start + 1}-${start + visible.length}）`
          : ''}
      </Text>
      {total === 0 ? (
        <Text dimColor>无匹配项，继续输入或退格修改</Text>
      ) : (
        visible.map((item, i) => {
          const globalIdx = start + i
          const active = globalIdx === sel
          const kindTag = item.kind === 'command' ? '命令' : '工具'
          return (
            <Box key={`${item.kind}-${item.id}-${globalIdx}`} flexDirection="row">
              <Text color={active ? 'cyan' : 'gray'} bold={active}>
                {active ? '› ' : '  '}
              </Text>
              <Text color={active ? 'cyan' : 'white'} bold={active}>
                [{kindTag}]{' '}
              </Text>
              <Text color={active ? 'cyan' : 'green'} bold={active}>
                {item.label}
              </Text>
              <Text dimColor wrap="truncate">
                {' '}
                — {item.desc}
              </Text>
            </Box>
          )
        })
      )}
    </Box>
  )
}

function MessageLine({ m }: { m: PersistedMessage }): React.ReactElement {
  if (m.role === 'user') {
    return (
      <Box
        flexDirection="column"
        marginBottom={1}
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
      >
        <Text color="cyan" bold>
          You
        </Text>
        <Text wrap="wrap">{m.content}</Text>
      </Box>
    )
  }
  if (m.role === 'assistant') {
    const toolHint = m.toolCalls?.length
      ? `[tools: ${m.toolCalls.map((t) => t.name).join(', ')}]`
      : ''
    return (
      <Box
        flexDirection="column"
        marginBottom={1}
        borderStyle="single"
        borderColor="white"
        paddingX={1}
      >
        <Text bold color="white">
          Assistant
        </Text>
        {(m.content ?? '').trim() ? (
          <Text wrap="wrap">{(m.content ?? '').trim()}</Text>
        ) : null}
        {toolHint ? <Text dimColor>{toolHint}</Text> : null}
      </Box>
    )
  }
  const preview =
    m.content.length > 400 ? `${m.content.slice(0, 400)}…` : m.content
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Text dimColor bold>
        tool · {m.name}
      </Text>
      <Text dimColor wrap="wrap">
        {preview}
      </Text>
    </Box>
  )
}
