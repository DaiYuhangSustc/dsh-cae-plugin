import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.e2e.ts'],
    testTimeout: 30_000,
  },
})
