import { defineConfig, devices } from '@playwright/test';

/**
 * WebWaka Transport — Playwright E2E Configuration
 * Tests run against the live production URL.
 * Mobile-First: primary test device is iPhone 12 viewport via Chromium.
 */
export default defineConfig({
  testDir: './playwright',
  timeout: 30_000,
  retries: 1,
  reporter: [['list'], ['json', { outputFile: 'playwright-report.json' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://webwaka-transport-ui.pages.dev',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'mobile-chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
      },
    },
  ],
});
