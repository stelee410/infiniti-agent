import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'liveui/src/**/*.test.ts'],
  },
})
