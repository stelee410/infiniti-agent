const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'
const ENTER_ALT_SCREEN = '\x1b[?1049h'
const EXIT_ALT_SCREEN = '\x1b[?1049l'
const ERASE_SCREEN = '\x1b[2J'
const CURSOR_HOME = '\x1b[H'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

function isSynchronizedOutputSupported(): boolean {
  if (process.env.TMUX) return false
  if (!process.stdout.isTTY) return false

  const termProgram = process.env.TERM_PROGRAM
  const term = process.env.TERM

  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true
  }

  if (term?.includes('kitty') || process.env.KITTY_WINDOW_ID) return true
  if (term === 'xterm-ghostty') return true
  if (term?.startsWith('foot')) return true
  if (term?.includes('alacritty')) return true
  if (process.env.ZED_TERM) return true
  if (process.env.WT_SESSION) return true

  const vteVersion = process.env.VTE_VERSION
  if (vteVersion) {
    const version = parseInt(vteVersion, 10)
    if (version >= 6800) return true
  }

  return false
}

const SYNC_SUPPORTED = isSynchronizedOutputSupported()

let originalWrite: typeof process.stdout.write | null = null

/**
 * Wrap every stdout.write in BSU/ESU (DEC 2026 synchronized output) so the
 * terminal buffers the whole frame and paints it atomically — no mid-frame
 * flicker.  No-op when the terminal doesn't support DEC 2026.
 */
export function enableSyncOutput(): void {
  if (!SYNC_SUPPORTED || originalWrite) return

  originalWrite = process.stdout.write.bind(process.stdout)
  const saved = originalWrite

  const wrapper: NodeJS.WriteStream['write'] = (
    chunk: unknown,
    ...rest: unknown[]
  ): boolean => {
    const content = typeof chunk === 'string' ? chunk : String(chunk)
    const wrapped = BSU + content + ESU
    return (saved as (...a: unknown[]) => boolean)(wrapped, ...rest)
  }
  process.stdout.write = wrapper
}

export function disableSyncOutput(): void {
  if (originalWrite) {
    process.stdout.write = originalWrite as typeof process.stdout.write
    originalWrite = null
  }
}

export function enterAlternateScreen(): void {
  process.stdout.write(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME + HIDE_CURSOR)
}

export function exitAlternateScreen(): void {
  process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN)
}
