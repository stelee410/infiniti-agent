import React, { useCallback, useEffect, useRef } from 'react'
import { Box, Text, useStdout, useInput } from 'ink'
import { readPackageVersion } from '../packageRoot.js'

type Props = {
  onDone: () => void
  durationMs?: number
}

export function Splash({
  onDone,
  durationMs = 2400,
}: Props): React.ReactElement {
  const { stdout } = useStdout()
  const rows = stdout?.rows ?? 24
  const cols = stdout?.columns ?? 80
  const topPad = Math.max(1, Math.floor((rows - 14) / 2))
  const barW = Math.min(cols - 4, 56)
  const doneRef = useRef(false)
  const finish = useCallback(() => {
    if (doneRef.current) {
      return
    }
    doneRef.current = true
    onDone()
  }, [onDone])

  useEffect(() => {
    const t = setTimeout(finish, durationMs)
    return () => clearTimeout(t)
  }, [finish, durationMs])

  useInput(() => {
    finish()
  })

  const v = readPackageVersion()

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Box height={topPad} />
      <Box flexDirection="column" alignItems="center">
        <Text dimColor>{'─'.repeat(barW)}</Text>
        <Box marginY={1} flexDirection="row">
          <Text bold color="cyan">
            ∞ INFINITI{' '}
          </Text>
          <Text bold color="white">
            AGENT
          </Text>
        </Box>
        <Text color="gray">LinkYun · 终端智能体</Text>
        <Box marginTop={1} flexDirection="row">
          <Text color="magenta">v{v}</Text>
          <Text dimColor> · SSE 流式</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="cyan">准备对话界面 …</Text>
        </Box>
        <Box marginY={1}>
          <Text dimColor>{'─'.repeat(barW)}</Text>
        </Box>
        <Text dimColor>按任意键跳过</Text>
      </Box>
    </Box>
  )
}
