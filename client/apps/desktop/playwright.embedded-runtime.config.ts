import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig({
  ...base,
  testMatch: 'embedded-codex-runtime.spec.ts',
  outputDir: '../../test-results/desktop-embedded-runtime-playwright',
  reporter: [
    ['line'],
    ['html', {
      outputFolder:
        '../../test-results/desktop-embedded-runtime-playwright-report',
      open: 'never'
    }]
  ],
  timeout: 240_000
});
