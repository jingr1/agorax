import { defineConfig, devices } from '@playwright/test'

/**
 * Chat turn / list chrome e2e. Requires UI on BASE_URL (default :6734).
 * Prefer mocked SSE routes — do not depend on a live LLM.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:6734',
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
