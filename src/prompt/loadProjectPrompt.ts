import { readFile } from 'fs/promises'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../packageRoot.js'
import { BUILTIN_CODE_QUALITY_SECTION } from './builtinCodeQuality.js'
import { BUILTIN_TOOL_AND_BOUNDARIES_SECTION } from './builtinToolPolicy.js'

/** 当工作目录与包内均未找到 SOUL.md 时使用 */
const FALLBACK_SOUL = `你是 Infiniti Agent（LinkYun），在终端中协助用户完成开发与自动化任务。
请简洁、可执行；需要时用工具（HTTP、shell、记忆）。执行 shell 前评估风险。`

export type AgentPromptDocs = {
  soul: string
  infiniti: string
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 加载人格与项目说明。
 * soul 优先级：cwd/SOUL.md → cwd/AGENTS.md → cwd/AGENT.md → PACKAGE_ROOT/SOUL.md → 内置 fallback
 * infiniti 优先级：cwd/INFINITI.md → cwd/CLAUDE.md → cwd/.claude/CLAUDE.md → PACKAGE_ROOT/INFINITI.md → ''
 */
export async function loadAgentPromptDocs(cwd: string): Promise<AgentPromptDocs> {
  const soul =
    (await tryRead(join(cwd, 'SOUL.md'))) ??
    (await tryRead(join(cwd, 'AGENTS.md'))) ??
    (await tryRead(join(cwd, 'AGENT.md'))) ??
    (await tryRead(join(PACKAGE_ROOT, 'SOUL.md'))) ??
    FALLBACK_SOUL

  const infiniti =
    (await tryRead(join(cwd, 'INFINITI.md'))) ??
    (await tryRead(join(cwd, 'CLAUDE.md'))) ??
    (await tryRead(join(cwd, '.claude', 'CLAUDE.md'))) ??
    (await tryRead(join(PACKAGE_ROOT, 'INFINITI.md'))) ??
    ''

  return {
    soul: soul.trimEnd(),
    infiniti: infiniti.trimEnd(),
  }
}

export function formatSystemFromDocs(docs: AgentPromptDocs): string {
  const blocks: string[] = [
    '## Agent 人格与准则（来源：SOUL.md）\n\n' + docs.soul.trim(),
  ]
  if (docs.infiniti.trim()) {
    blocks.push(
      '## 项目与运行说明（来源：INFINITI.md）\n\n' + docs.infiniti.trim(),
    )
  }
  return blocks.join('\n\n')
}

const IDENTITY_SECTION = `## 身份

You are **Infiniti Agent** (by LinkYun).
- Your persona and principles live in **SOUL.md**; if absent, the system will load **AGENTS.md** or **AGENT.md** as fallback.
- Project-specific instructions live in **INFINITI.md**; if absent, the system will load **CLAUDE.md** (including .claude/CLAUDE.md) as fallback.
- You may read and edit any of these files (SOUL.md, INFINITI.md, CLAUDE.md, AGENT.md, AGENTS.md) as the user requests.
- The current working directory (where the user launched the CLI) is used to locate these files.`

/** SOUL/INFINITI 文档 + 内置代码质量约定 + 内置工具与 TUI 约定（与实现同步） */
export function buildAgentSystemPrompt(docs: AgentPromptDocs): string {
  return [
    IDENTITY_SECTION,
    formatSystemFromDocs(docs),
    BUILTIN_CODE_QUALITY_SECTION,
    BUILTIN_TOOL_AND_BOUNDARIES_SECTION,
  ].join('\n\n')
}
