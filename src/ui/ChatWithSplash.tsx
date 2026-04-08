import React, { useCallback, useState } from 'react'
import type { InfinitiConfig } from '../config/types.js'
import type { McpManager } from '../mcp/manager.js'
import { ChatApp } from './ChatApp.js'
import { Splash } from './Splash.js'

type Props = {
  config: InfinitiConfig
  mcp: McpManager
  dangerouslySkipPermissions?: boolean
}

export function ChatWithSplash({ config, mcp, dangerouslySkipPermissions }: Props): React.ReactElement {
  const [phase, setPhase] = useState<'splash' | 'chat'>('splash')
  const onSplashDone = useCallback(() => setPhase('chat'), [])
  if (phase === 'splash') {
    return <Splash onDone={onSplashDone} />
  }
  return <ChatApp config={config} mcp={mcp} dangerouslySkipPermissions={dangerouslySkipPermissions} />
}
