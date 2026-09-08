import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { claweeAppVersion } from './build-metadata.js';

export default defineConfig({
  define: {
    __CLAWEE_APP_VERSION__: JSON.stringify(claweeAppVersion)
  },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts']
  }
});
