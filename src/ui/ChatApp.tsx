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
  dangerouslySkipPermissions?: boolean
}

const STREAM_DEBOUNCE_MS = 48
const SLASH_MENU_MAX_ROWS = 10

export function ChatApp({ config: initialConfig, mcp, dangerouslySkipPermissions }: Props): React.ReactElement {
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
  /** 单个工具的会话级白名单（按 A 加入） */
  const [toolWhitelist, setToolWhitelist] = useState<Set<string>>(new Set())
  const [toolGate, setToolGate] = useState<null | {
    name: string
    detail: string
    resolve: (answer: 'yes' | 'no' | 'always') => void
  }>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)
  /** 比泛化的「请求中」更细：等首包 / 执行工具 / SSE 中 */
  const [busySubtext, setBusySubtext] = useState<string | null>(null)
  const [busyDiag, setBusyDiag] = useState({ elapsed: 0, stall: 0 })
  const lastStreamDeltaAtRef = useRef<number | null>(null)

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

  useEffect(() => {
    if (!busy) {
      setBusyDiag({ elapsed: 0, stall: 0 })
      return
    }
    const start = Date.now()
    lastStreamDeltaAtRef.current = null
    setBusyDiag({ elapsed: 0, stall: 0 })
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000)
      const last = lastStreamDeltaAtRef.current
      const stall = last ? Math.floor((Date.now() - last) / 1000) : 0
      setBusyDiag({ elapsed, stall })
    }, 1000)
    return () => clearInterval(id)
  }, [busy])

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
      if (dangerouslySkipPermissions || toolWhitelist.has(info.name)) {
        return true
      }
      const answer = await new Promise<'yes' | 'no' | 'always'>((resolve) => {
        setToolGate({
          name: info.name,
          detail: info.detail,
          resolve,
        })
      })
      if (answer === 'always') {
        setToolWhitelist((prev) => new Set(prev).add(info.name))
        return true
      }
      return answer === 'yes'
    },
    [dangerouslySkipPermissions, toolWhitelist],
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
    const paths = [
      join(cwd, 'SOUL.md'),
      join(cwd, 'INFINITI.md'),
      join(cwd, 'CLAUDE.md'),
      join(cwd, '.claude', 'CLAUDE.md'),
      join(cwd, 'AGENT.md'),
      join(cwd, 'AGENTS.md'),
    ]
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
          '输入 / 可补全：斜杠命令与全部工具（↑↓ Tab）。命令: /exit /clear /reload /memory /undo /compact /permission — 改文件/bash/HTTP 默认需确认（Y 允许 · A 本次会话始终允许该工具 · N 拒绝）；启动时加 --dangerously-skip-permissions 可跳过所有确认。/permission 查看当前状态。/compact 压缩较早历史。卡死排查：INFINITI_AGENT_DEBUG=1。',
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
      if (raw === '/permission') {
        const wl = [...toolWhitelist]
        const mode = dangerouslySkipPermissions
          ? '全部跳过（--dangerously-skip-permissions）'
          : wl.length
            ? `逐项确认，已放行: ${wl.join(', ')}`
            : '逐项确认（确认时按 A 可将工具加入白名单）'
        setNotice(`权限模式: ${mode}`)
        setTimeout(() => setNotice(null), 8000)
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
      setBusySubtext('等待模型响应（首包/跨境 API 可能较慢）…')
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
          onToolDispatch: (name) => {
            setBusySubtext(`执行工具：${name}…`)
          },
          stream: {
            onStreamReset: () => {
              resetStream()
              lastStreamDeltaAtRef.current = null
              setBusySubtext('等待模型响应（多轮工具之间会重新请求）…')
            },
            onTextDelta: (_delta, full) => {
              lastStreamDeltaAtRef.current = Date.now()
              setBusySubtext(
                'SSE 流式中（久无新字时：可能在生成 tool 调用或网络慢）…',
              )
              flushStream(full)
            },
            onToolUseStart: (toolName) => {
              setBusySubtext(
                `模型正在生成 ${toolName} 调用参数（SSE 仍在传输中）…`,
              )
            },
          },
        })
        setMessages(out)
        await saveSession(cwd, out)
      } catch (e: unknown) {
        setError(formatChatError(e))
      } finally {
        setBusySubtext(null)
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
  const wlNames = [...toolWhitelist]
  const permLabel = dangerouslySkipPermissions
    ? ' · ⚠ 跳过确认'
    : wlNames.length
      ? ` · 放行: ${wlNames.join(',')}`
      : ''
  const meta = `${config.llm.provider} · ${config.llm.model}${permLabel}`

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
        输入 / 补全命令与工具 · ↑↓ Tab · SOUL/INFINITI/CLAUDE/AGENT 热重载
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
              : `◆ ${
                  busySubtext ??
                  '请求中（Anthropic/OpenAI/Gemini 均走流式 SSE）…'
                }${busyDiag.elapsed > 0 ? ` · 已 ${busyDiag.elapsed}s` : ''}${
                  busyDiag.stall >= 12 && lastStreamDeltaAtRef.current != null
                    ? ` · ${busyDiag.stall}s 无新字`
                    : ''
                }`}
          </Text>
        </Box>
      ) : null}

      {toolGate ? (
        <ToolConfirmDialog
          name={toolGate.name}
          detail={toolGate.detail}
          onAnswer={(answer) => {
            setToolGate((g) => {
              g?.resolve(answer)
              return null
            })
          }}
        />
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
  onAnswer: (answer: 'yes' | 'no' | 'always') => void
}): React.ReactElement {
  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') {
        onAnswer('yes')
        return
      }
      if (input === 'a' || input === 'A') {
        onAnswer('always')
        return
      }
      if (input === 'n' || input === 'N' || key.escape) {
        onAnswer('no')
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
      <Text dimColor>Y 允许 · A 本次会话始终允许此工具 · N / Esc 拒绝</Text>
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
