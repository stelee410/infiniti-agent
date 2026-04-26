import { describe, expect, it } from 'vitest'
import { markdownToTtsPlainText } from './markdownToTtsPlainText.js'

describe('markdownToTtsPlainText', () => {
  it('strips headings list markers and links', () => {
    const out = markdownToTtsPlainText(
      '## 标题\n\n- 一项 [点我](https://a.com) 继续',
    )
    expect(out).toContain('标题')
    expect(out).toContain('一项')
    expect(out).toContain('点我')
    expect(out).not.toMatch(/\[|]|#/)
  })

  it('removes fenced code and inline code', () => {
    expect(markdownToTtsPlainText('前文 `npm i` 后文')).toBe('前文 npm i 后文')
    expect(markdownToTtsPlainText('x ```js\na=1\n``` y')).toBe('x y')
  })

  it('collapses bold and strikethrough', () => {
    expect(markdownToTtsPlainText('**粗** ~~删~~')).toBe('粗 删')
  })

  it('strips bare URLs', () => {
    expect(markdownToTtsPlainText('见 https://x.com/foo 结束')).toBe('见 结束')
  })

  it('removes parenthetical asides before TTS', () => {
    expect(markdownToTtsPlainText('你好（笑一下），我来了 (whisper: soft)。')).toBe('你好 ，我来了 。')
    expect(markdownToTtsPlainText('开始（动作（内层）提示）结束')).toBe('开始 结束')
    expect(markdownToTtsPlainText('你好[微笑]，我来了【挥手】。')).toBe('你好 ，我来了 。')
    expect(markdownToTtsPlainText('先说{动作: 点头}再说｛不要朗读｝结束')).toBe('先说 再说 结束')
    expect(markdownToTtsPlainText('）残留闭括号也不要读，继续。')).toBe('残留闭括号也不要读，继续。')
  })

  it('removes emoji and emoji sequences before TTS', () => {
    expect(markdownToTtsPlainText('太好了 😊！我们开始吧 🚀')).toBe('太好了 ！我们开始吧')
    expect(markdownToTtsPlainText('OK 👍🏽 family 👨‍👩‍👧‍👦 flag 🇨🇳')).toBe('OK family flag')
  })
})
