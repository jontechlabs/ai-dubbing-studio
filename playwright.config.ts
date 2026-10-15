import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.pw.ts',
  workers: 1,
  // A cold browser/decoder on the shared Windows runner can take over 5 s.
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://127.0.0.1:1420',
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
    locale: 'fr-FR',
    viewport: { width: 1440, height: 940 },
  },
});
