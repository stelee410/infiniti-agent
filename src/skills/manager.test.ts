import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { executeSkillAction } from './manager.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-skill-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const sampleSkillContent = `# Deploy K8s

## When to Use
When deploying to Kubernetes clusters.

## Procedure
1. Build Docker image
2. Push to registry
3. Apply manifests

## Pitfalls
- Don't forget resource limits
`

describe('executeSkillAction — create', () => {
  it('creates a skill with SKILL.md', async () => {
    const res = await executeSkillAction(cwd, {
      action: 'create',
      name: 'deploy-k8s',
      content: sampleSkillContent,
    })
    expect(res.ok).toBe(true)
    expect(res.path).toContain('deploy-k8s')
    expect(res.path).toContain('SKILL.md')

    const content = await readFile(res.path!, 'utf8')
    expect(content).toBe(sampleSkillContent)
  })

  it('rejects empty content', async () => {
    const res = await executeSkillAction(cwd, {
      action: 'create',
      name: 'empty',
      content: '',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('content')
  })

  it('sanitizes skill name', async () => {
    const res = await executeSkillAction(cwd, {
      action: 'create',
      name: 'my skill/../../etc',
      content: '# Test',
    })
    expect(res.ok).toBe(true)
    expect(res.path).not.toContain('..')
  })

  it('rejects empty name', async () => {
    const res = await executeSkillAction(cwd, {
      action: 'create',
      name: '',
      content: '# Test',
    })
    expect(res.ok).toBe(false)
  })
})

describe('executeSkillAction — patch', () => {
  it('patches an existing skill', async () => {
    await executeSkillAction(cwd, {
      action: 'create',
      name: 'deploy-k8s',
      content: sampleSkillContent,
    })

    const res = await executeSkillAction(cwd, {
      action: 'patch',
      name: 'deploy-k8s',
      old_string: "Don't forget resource limits",
      new_string: "Always set CPU and memory limits\n- Check liveness probes",
    })
    expect(res.ok).toBe(true)

    const updated = await readFile(res.path!, 'utf8')
    expect(updated).toContain('Always set CPU and memory limits')
    expect(updated).toContain('Check liveness probes')
    expect(updated).not.toContain("Don't forget resource limits")
  })

  it('errors when old_string not found', async () => {
    await executeSkillAction(cwd, {
      action: 'create',
      name: 'deploy-k8s',
      content: sampleSkillContent,
    })

    const res = await executeSkillAction(cwd, {
      action: 'patch',
      name: 'deploy-k8s',
      old_string: 'nonexistent text',
      new_string: 'replacement',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未找到')
  })

  it('errors when skill does not exist', async () => {
    const res = await executeSkillAction(cwd, {
      action: 'patch',
      name: 'nonexistent',
      old_string: 'a',
      new_string: 'b',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不存在')
  })

  it('rejects when old_string appears multiple times', async () => {
    await executeSkillAction(cwd, {
      action: 'create',
      name: 'test',
      content: 'abc abc abc',
    })
    const res = await executeSkillAction(cwd, {
      action: 'patch',
      name: 'test',
      old_string: 'abc',
      new_string: 'xyz',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('3 次')
  })
})

describe('executeSkillAction — delete', () => {
  it('deletes an existing skill', async () => {
    await executeSkillAction(cwd, {
      action: 'create',
      name: 'deploy-k8s',
      content: sampleSkillContent,
    })

    const res = await executeSkillAction(cwd, {
      action: 'delete',
      name: 'deploy-k8s',
    })
    expect(res.ok).toBe(true)
  })

  it('succeeds even if skill does not exist (force delete)', async () => {
    const res = await executeSkillAction(cwd, {
      action: 'delete',
      name: 'nonexistent',
    })
    expect(res.ok).toBe(true)
  })
})
