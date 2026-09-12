import { defineConfig } from '../client/node_modules/@playwright/test/index.mjs';

export default defineConfig({
  testDir: '.',
  testMatch: 'first-launch.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  outputDir: '../client/test-results/customer-first-launch',
  reporter: [['line'], ['json', { outputFile: '../client/test-results/customer-first-launch.json' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
});
