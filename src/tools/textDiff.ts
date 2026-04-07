import { createTwoFilesPatch } from 'diff'

const MAX_DIFF_CHARS = 96 * 1024

export function fileUnifiedDiff(
  relPath: string,
  oldStr: string,
  newStr: string,
): string {
  return createTwoFilesPatch(relPath, relPath, oldStr, newStr, '', '')
}

export function truncateDiffText(patch: string, max = MAX_DIFF_CHARS): string {
  if (patch.length <= max) {
    return patch
  }
  return `${patch.slice(0, max)}\n\n…(diff 已截断，共 ${patch.length} 字符)`
}
