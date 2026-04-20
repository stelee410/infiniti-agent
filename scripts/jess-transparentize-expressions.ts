/**
 * 将 live2d-models/jess/expression/*.png 做边缘连通背景抠透明，
 * 输出到 expression_web/ 供 jess-mesh-lab 使用。
 *
 * 用法（仓库根目录）: npx tsx scripts/jess-transparentize-expressions.ts
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fg from 'fast-glob'
import { transparentizeStudioBackgroundPng } from '../src/avatar/transparentizePngBackground.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

async function main(): Promise<void> {
  const expr = join(root, 'live2d-models', 'jess', 'expression')
  const out = join(root, 'live2d-models', 'jess', 'expression_web')
  const labPublic = join(root, 'jess-mesh-lab', 'public', 'jess')
  await mkdir(out, { recursive: true })
  await mkdir(labPublic, { recursive: true })
  const files = await fg('*.png', { cwd: expr, onlyFiles: true })
  if (files.length === 0) {
    console.error(`未找到 PNG: ${expr}`)
    process.exit(2)
  }
  for (const f of files) {
    const buf = await readFile(join(expr, f))
    const result = await transparentizeStudioBackgroundPng(buf)
    const outPath = join(out, f)
    await writeFile(outPath, result)
    await copyFile(outPath, join(labPublic, f))
    console.error(`OK  ${f} → expression_web/ + jess-mesh-lab/public/jess/`)
  }
  console.error(`\n完成，共 ${files.length} 张。请运行: npm run jess:lab:dev`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
