import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 指向 npm 包根目录（含 SOUL.md / INFINITI.md），无论从 dist 或 tsx 运行 */
const __dirname = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = join(__dirname, '..')

export function readPackageVersion(): string {
  try {
    const p = join(PACKAGE_ROOT, 'package.json')
    return JSON.parse(readFileSync(p, 'utf8')).version as string
  } catch {
    return '0.0.1'
  }
}
