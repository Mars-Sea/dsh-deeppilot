import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e', testMatch: '**/*.spec.ts',
  fullyParallel: true, workers: 2, forbidOnly: Boolean(process.env.CI),
  reporter: 'list', timeout: 20000,
  use: {
    baseURL: 'http://127.0.0.1:4781', viewport: { width: 1000, height: 1000 },
    // 本机可用系统 Chrome；CI 默认用 playwright install chromium 提供的浏览器。
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx scripts/settings-preview.mts',
    url: 'http://127.0.0.1:4781', reuseExistingServer: !process.env.CI,
  },
})
