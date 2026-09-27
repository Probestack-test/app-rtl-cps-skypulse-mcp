import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // lcov.info is what the coverage runner reads; the summary is for people.
      reporter: ['text-summary', 'lcov'],
    },
  },
})
