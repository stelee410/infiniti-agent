import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.use({
  gfm: true,
  breaks: true,
})

/**
 * 将助手气泡内的 Markdown 转为可安全插入的 HTML（DOMPurify 消毒，防 XSS）。
 * 流式阶段会对「当前前缀」反复解析，未闭合的语法多数会按字面回落，属预期行为。
 */
export function renderLiveUiBubbleMarkdown(mdSource: string): string {
  if (!mdSource) return ''
  try {
    const html = marked.parse(mdSource, { async: false }) as string
    return DOMPurify.sanitize(html)
  } catch {
    return ''
  }
}
