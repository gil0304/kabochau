import { defineConfig } from 'vitest/config'

// Unit tests cover the pure (DOM / WebGL free) modules in app/utils.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
