// Real-browser E2E for the sample app. Chromium: PLAYWRIGHT_BROWSERS_PATH (revision 1194 for
// @playwright/test 1.56.1) or SUPERAGENT_CHROMIUM=/path/to/chrome.
import { defineConfig } from '@playwright/test'

const port = Number(process.env.SAMPLE_PORT ?? 4321)
export default defineConfig({
  testDir: 'e2e',
  timeout: 20_000,
  reporter: [['list'], ['json']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    launchOptions: process.env.SUPERAGENT_CHROMIUM ? { executablePath: process.env.SUPERAGENT_CHROMIUM } : {},
  },
  webServer: { command: `PORT=${port} node server.js`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 15_000 },
})
