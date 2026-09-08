import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultBackendURL = "http://127.0.0.1:1904";
const defaultDevPort = 5904;
const backendURL = process.env.VITE_BACKEND_URL ?? defaultBackendURL;
const devPort = Number(process.env.VITE_DEV_PORT ?? defaultDevPort);
const analyzeBundle = process.env.ANALYZE === "true";

export default defineConfig({
  plugins: [
    react(),
    analyzeBundle
      ? visualizer({
          filename: "dist/bundle-stats.html",
          gzipSize: true,
          brotliSize: true,
          template: "treemap"
        })
      : null
  ],
  server: {
    host: "0.0.0.0",
    port: devPort,
    proxy: {
      "/api/v1/auth": backendURL,
      "/api/v1/app": backendURL,
      "/api/v1/admin": backendURL
    }
  },
  preview: {
    host: "0.0.0.0"
  },
  build: {
    outDir: "../internal/server/webdist/dist",
    emptyOutDir: true
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src")
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts"
  }
});
