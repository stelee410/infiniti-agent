import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const agentRoot = path.resolve(__dirname, '..')

export default defineConfig({
  root: __dirname,
  base: './',
  publicDir: 'public',
  server: {
    fs: { allow: [agentRoot] },
  },
  resolve: {
    alias: { '@agent': path.join(agentRoot, 'src') },
    dedupe: ['pixi.js'],
  },
  optimizeDeps: { include: ['pixi.js'] },
  build: { outDir: 'dist', emptyOutDir: true },
})
