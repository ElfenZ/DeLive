import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Native Electron/PowerShell fixtures contend with transforms on high-core Windows hosts.
    maxWorkers: 4,
    include: ['src/**/*.test.ts'],
  },
})
