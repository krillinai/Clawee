import { defineConfig } from '@playwright/test';

const devPort = process.env.VITE_DEV_PORT ?? '5904';
const baseURL = `http://127.0.0.1:${devPort}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  webServer: {
    command: `pnpm dev -- --host 127.0.0.1 --port ${devPort}`,
    url: baseURL,
    reuseExistingServer: true,
  },
  use: {
    channel: 'chrome',
    baseURL,
    headless: false,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
