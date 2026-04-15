import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: './',
  resolve: {
    dedupe: ['pixi.js', '@pixi/core', '@pixi/display', '@pixi/math', '@pixi/utils', '@pixi/ticker', '@pixi/interaction'],
  },
  optimizeDeps: {
    include: ['pixi.js', 'pixi-live2d-display/cubism4'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: './index.html',
    },
  },
})
