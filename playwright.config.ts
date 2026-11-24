import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// E2E runs against the production build served by `vite preview`.
// Build first (`npm run build`). Pick another port with E2E_PORT=4400 npm run test:e2e.
const port = Number(process.env.E2E_PORT ?? 4173)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`E2E_PORT must be a port number, got "${process.env.E2E_PORT}"`)
if (!existsSync('dist/index.html')) throw new Error('dist/ is missing. Run `npm run build` before `npm run test:e2e`.')

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Deterministic dates, and no hero auto-play or number tweening.
    timezoneId: 'UTC',
    locale: 'en-US',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    // Never test against a server somebody else left running.
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
