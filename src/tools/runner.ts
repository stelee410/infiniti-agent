import type { InfinitiConfig } from '../config/types.js'
import type { LiveUiVisionAttachment } from '../liveui/protocol.js'
import type { LiveUiSession } from '../liveui/wsSession.js'
import type { AvatarGenReferenceImage } from '../avatar/real2dAvatarGen.js'
import type { SeedanceReferenceImage } from '../video/generateSeedanceVideo.js'
import type { MemoryAction } from '../memory/structured.js'
import type { ProfileAction } from '../memory/userProfile.js'
import type { KgAction } from '../memory/knowledgeGraph.js'
import type { EditHistory } from '../session/editHistory.js'
import type { BuiltinToolName } from './definitions.js'
import { builtinToolHandlers, toolError } from './builtinToolHandlers.js'

export type ToolRunContext = {
  sessionCwd: string
  config: InfinitiConfig
  snapVision?: LiveUiVisionAttachment
  seedanceImages?: SeedanceReferenceImage[]
  avatarGenImages?: AvatarGenReferenceImage[]
  editHistory?: EditHistory
  liveUi?: LiveUiSession | null
  memoryCoordinator?: {
    executeMemoryAction(act: MemoryAction): Promise<unknown>
    executeProfileAction(act: ProfileAction): Promise<unknown>
    executeKgAction?(act: KgAction): Promise<unknown>
  }
}

export async function runBuiltinTool(
  name: BuiltinToolName,
  argsJson: string,
  ctx: ToolRunContext,
): Promise<string> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return toolError('工具参数不是合法 JSON')
  }

  const handler = builtinToolHandlers[name]
  if (!handler) {
    return toolError('未知内置工具')
  }
  return handler(args, ctx)
}
