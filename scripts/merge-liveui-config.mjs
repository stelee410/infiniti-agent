#!/usr/bin/env node
/**
 * 将仓库内 docs/liveui.fragment.json 合并进「当前工作目录」的 .infiniti-agent/config.json，
 * 并在缺少 ./model_dict.json 时从 model_dict.example.json 复制一份。
 *
 * 用法：
 *   在项目根执行（cwd 即项目）：
 *     node /path/to/infiniti-agent/scripts/merge-liveui-config.mjs
 *   或指定项目目录（在 infiniti-agent 仓库里 npm run 时常用）：
 *     npm run setup:liveui -- /path/to/your-project
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(__dirname, '..')
const projectRoot = resolve(process.argv[2] ?? process.cwd())
const configPath = join(projectRoot, '.infiniti-agent', 'config.json')
const fragmentPath = join(packageRoot, 'docs', 'liveui.fragment.json')
const modelDictExample = join(packageRoot, 'model_dict.example.json')
const modelDictDest = join(projectRoot, 'model_dict.json')

if (!existsSync(configPath)) {
  console.error(
    `未找到 ${configPath}。\n` +
      '请先在目标项目执行: infiniti-agent migrate（或 init 后再 migrate）。\n' +
      '若在仓库根执行本脚本，请传入项目路径: npm run setup:liveui -- /path/to/project',
  )
  process.exit(1)
}

if (!existsSync(fragmentPath)) {
  console.error('未找到片段文件:', fragmentPath)
  process.exit(1)
}

let cfg
try {
  cfg = JSON.parse(readFileSync(configPath, 'utf8'))
} catch (e) {
  console.error('读取 config.json 失败:', e instanceof Error ? e.message : String(e))
  process.exit(1)
}

if (cfg.version !== 1) {
  console.error('config.json 须为 version: 1')
  process.exit(1)
}

const frag = JSON.parse(readFileSync(fragmentPath, 'utf8'))
cfg.liveUi = { ...(cfg.liveUi && typeof cfg.liveUi === 'object' ? cfg.liveUi : {}), ...frag.liveUi }

mkdirSync(dirname(configPath), { recursive: true })
writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
console.log('已合并 liveUi 到', configPath)

if (!existsSync(modelDictDest) && existsSync(modelDictExample)) {
  copyFileSync(modelDictExample, modelDictDest)
  console.log('已创建', modelDictDest, '（可按需编辑；模型文件请放入 live2d-models/）')
}
