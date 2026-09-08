import base from './playwright.config.js';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  ...base,
  testMatch: 'external-model.smoke.ts',
  retries: 0,
  timeout: 300_000,
  reporter: [['line']],
  use: { ...base.use, screenshot: 'off', trace: 'off', video: 'off' }
});
