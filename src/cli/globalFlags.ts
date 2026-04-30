export type ParsedGlobalFlags = {
  argv: string[]
  debug: boolean
  skipPermissions: boolean
  disableThinking: boolean
}

export function parseGlobalFlags(argv: string[]): ParsedGlobalFlags {
  const out: string[] = []
  let debug = false
  let skipPermissions = false
  let disableThinking = false
  for (const arg of argv) {
    if (arg === '--debug') {
      debug = true
    } else if (arg === '--dangerously-skip-permissions') {
      skipPermissions = true
    } else if (arg === '--disable-thinking') {
      disableThinking = true
    } else {
      out.push(arg)
    }
  }
  return {
    argv: out,
    debug,
    skipPermissions,
    disableThinking,
  }
}
