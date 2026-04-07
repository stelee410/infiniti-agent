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
  buildAgentSystemPrompt,
} from '../prompt/loadProjectPrompt.js'
import { compactSessionMessages } from '../llm/compactSession.js'
import { resolvedCompactionSettings } from '../llm/compactionSettings.js'
import { estimateMessagesTokens } from '../llm/estimateTokens.js'
import { runToolLoop } from '../llm/runLoop.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { saveSession, loadSession } from '../session/file.js'
import { SKILLS_DIR } from '../paths.js'
import type { McpManager } from '../mcp/manager.js'
import { loadConfig } from '../config/io.js'
import { formatChatError } from '../utils/formatError.js'
import { EditHistory } from '../session/editHistory.js'
import { restoreEditSnapshot } from '../tools/repoTools.js'
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
  const editHistoryRef = useRef(new EditHistory())
  const [slashIndex, setSlashIndex] = useState(0)
  const [approveAllTools, setApproveAllTools] = useState(false)
  const [toolGate, setToolGate] = useState<null | {
    name: string
    detail: string
    resolve: (ok: boolean) => void
  }>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)

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

  const confirmTool = useCallback(
    async (info: { name: string; detail: string }) => {
      if (approveAllTools) {
        return true
      }
      return new Promise<boolean>((resolve) => {
        setToolGate({
          name: info.name,
          detail: info.detail,
          resolve,
        })
      })
    },
    [approveAllTools],
  )

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
    const parts = [buildAgentSystemPrompt(docs)]
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
          '输入 / 可补全：斜杠命令与全部工具（↑↓ Tab）。命令: /exit /clear /reload /memory /undo /approve-all /compact — 改文件与 bash/HTTP 默认需确认（可 /approve-all）。/compact 压缩较早历史；自动压缩见 config compaction.autoThresholdTokens。其余发给模型（SSE）',
        )
        setInput('')
        return
      }
      if (raw === '/compact' || raw.startsWith('/compact ')) {
        const instr = raw.startsWith('/compact ')
          ? raw.slice('/compact '.length).trim()
          : ''
        if (messages.length < 2) {
          setError('消息过少，无需压缩')
          setInput('')
          return
        }
        setBusy(true)
        setCompacting(true)
        setError(null)
        setNotice('正在压缩会话历史（非流式）…')
        try {
          const cs = resolvedCompactionSettings(config)
          const next = await compactSessionMessages({
            config,
            cwd,
            messages,
            minTailMessages: cs.minTailMessages,
            maxToolSnippetChars: cs.maxToolSnippetChars,
            customInstructions: instr || undefined,
            preCompactHook: cs.preCompactHook,
          })
          setMessages(next)
          await saveSession(cwd, next)
          setNotice(`已压缩：保留最近约 ${cs.minTailMessages} 条消息起的上下文`)
          setTimeout(() => setNotice(null), 5000)
        } catch (e: unknown) {
          setError(formatChatError(e))
          setNotice(null)
        } finally {
          setCompacting(false)
          setBusy(false)
        }
        setInput('')
        return
      }
      if (raw === '/approve-all') {
        setApproveAllTools((v) => {
          const next = !v
          setNotice(
            next
              ? '已开启：本会话内敏感工具将自动批准'
              : '已关闭：改文件 / bash / http_request 将逐项确认',
          )
          setTimeout(() => setNotice(null), 5000)
          return next
        })
        setInput('')
        return
      }
      if (raw === '/undo') {
        const snap = editHistoryRef.current.peek()
        if (!snap) {
          setError('没有可撤销的编辑（仅记录本会话内成功的 write_file / str_replace）')
          setInput('')
          return
        }
        try {
          const out = await restoreEditSnapshot(cwd, snap)
          const j = JSON.parse(out) as { ok?: boolean; error?: string }
          if (!j.ok) {
            setError(j.error ?? '撤销失败')
          } else {
            editHistoryRef.current.pop()
            setError(null)
            setNotice(`已撤销: ${snap.relPath}`)
            setTimeout(() => setNotice(null), 4000)
          }
        } catch (e: unknown) {
          setError(formatChatError(e))
        }
        setInput('')
        return
      }

      setBusy(true)
      setError(null)
      resetStream()
      const userLine = raw

      let baseMessages = messages
      const cs = resolvedCompactionSettings(config)
      if (
        cs.autoThresholdTokens > 0 &&
        estimateMessagesTokens(baseMessages) >= cs.autoThresholdTokens
      ) {
        setCompacting(true)
        setNotice('历史较长，正在自动压缩上下文（非流式）…')
        try {
          baseMessages = await compactSessionMessages({
            config,
            cwd,
            messages: baseMessages,
            minTailMessages: cs.minTailMessages,
            maxToolSnippetChars: cs.maxToolSnippetChars,
            preCompactHook: cs.preCompactHook,
          })
          setMessages(baseMessages)
          await saveSession(cwd, baseMessages)
          setNotice('已自动压缩，正在请求模型…')
        } catch (e: unknown) {
          setError(formatChatError(e))
          setNotice(null)
          setCompacting(false)
          setBusy(false)
          return
        } finally {
          setCompacting(false)
        }
      }

      const nextMsgs: PersistedMessage[] = [
        ...baseMessages,
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
          confirmTool,
          editHistory: editHistoryRef.current,
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
      confirmTool,
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
  const meta = `${config.llm.provider} · ${config.llm.model}${
    approveAllTools ? ' · 自动批准' : ''
  }`

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

      {notice ? (
        <Box marginY={1} paddingX={1}>
          <Text dimColor>{notice}</Text>
        </Box>
      ) : null}

      {error ? (
        <Box marginY={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}

      {toolGate ? (
        <ToolConfirmDialog
          name={toolGate.name}
          detail={toolGate.detail}
          onAnswer={(ok) => {
            setToolGate((g) => {
              g?.resolve(ok)
              return null
            })
          }}
        />
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
            {compacting
              ? '◆ 正在压缩会话历史（非流式）…'
              : '◆ 请求中（Anthropic/OpenAI/Gemini 均走流式 SSE）…'}
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
          focus={!busy && sessionReady && !toolGate}
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

function ToolConfirmDialog({
  name,
  detail,
  onAnswer,
}: {
  name: string
  detail: string
  onAnswer: (ok: boolean) => void
}): React.ReactElement {
  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') {
        onAnswer(true)
        return
      }
      if (input === 'n' || input === 'N' || key.escape) {
        onAnswer(false)
      }
    },
    { isActive: true },
  )
  const shown =
    detail.length > 12_000
      ? `${detail.slice(0, 12_000)}\n\n…（展示已截断，共 ${detail.length} 字符）`
      : detail
  const lines = shown.split('\n')
  const maxLines = 48
  const slice = lines.slice(0, maxLines)
  const omitted =
    lines.length > maxLines ? `\n… 另有 ${lines.length - maxLines} 行未展示` : ''

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="yellow">
        确认工具 · {name}
      </Text>
      <Text dimColor>Y 允许 · N / Esc 拒绝</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor wrap="wrap">
          {slice.join('\n')}
          {omitted}
        </Text>
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
