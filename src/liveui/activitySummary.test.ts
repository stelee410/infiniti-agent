import { describe, it, expect } from 'vitest'
import { activityVerb, activityDetail, summarizeToolActivity } from './activitySummary.js'

describe('activitySummary', () => {
  it('maps known tools to a Chinese verb, falls back to raw name', () => {
    expect(activityVerb('bash')).toBe('运行命令')
    expect(activityVerb('read_file')).toBe('读取文件')
    expect(activityVerb('some_mcp_tool')).toBe('some_mcp_tool')
  })

  it('extracts the most relevant arg as detail', () => {
    expect(activityDetail('{"command":"npm test"}')).toBe('npm test')
    expect(activityDetail('{"path":"src/main.ts"}')).toBe('src/main.ts')
    expect(activityDetail('{"pattern":"TODO"}')).toBe('TODO')
    expect(activityDetail('{"url":"https://x.y"}')).toBe('https://x.y')
  })

  it('collapses whitespace and truncates long detail', () => {
    const long = 'a'.repeat(200)
    const out = activityDetail(JSON.stringify({ command: `echo   ${long}` }))
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns empty detail for unparseable or empty args', () => {
    expect(activityDetail('not json')).toBe('')
    expect(activityDetail('{}')).toBe('')
  })

  it('combines verb and detail; verb only when no detail', () => {
    expect(summarizeToolActivity('bash', '{"command":"ls -la"}')).toBe('运行命令 · ls -la')
    expect(summarizeToolActivity('memory', '{}')).toBe('整理记忆')
  })
})
