import { readFile } from 'fs/promises'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../packageRoot.js'

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
 * 加载人格与项目说明：优先当前工作目录，其次内置包内文件。
 * INFINITI.md 中可引用 SOUL.md；二者正文都会在系统提示中注入。
 */
export async function loadAgentPromptDocs(cwd: string): Promise<AgentPromptDocs> {
  const soul =
    (await tryRead(join(cwd, 'SOUL.md'))) ??
    (await tryRead(join(PACKAGE_ROOT, 'SOUL.md'))) ??
    FALLBACK_SOUL

  const infiniti =
    (await tryRead(join(cwd, 'INFINITI.md'))) ??
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
