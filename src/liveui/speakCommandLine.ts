/**
 * 解析 `infiniti-agent live` 下「仅朗读、不落库」命令 `/speak <文本>`（前缀大小写不敏感）。
 *
 * @returns `undefined` 表示整行不是该命令；否则为去掉首尾空白后的朗读正文（可能为空串，表示缺正文）。
 */
export function parseSpeakCommandLine(trimmedLine: string): string | undefined {
  const t = trimmedLine.trimEnd()
  if (!/^\/speak\b/i.test(t)) return undefined
  return t.replace(/^\/speak\b/i, '').trim()
}
