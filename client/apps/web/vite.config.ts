import react from '@vitejs/plugin-react';
import { request as httpRequest } from 'node:http';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { claweeAppVersion } from './build-metadata.js';
import {
  DEV_RUNTIME_PROXY_BASE,
  buildDevProxyTarget,
  parseDevDaemonConfig,
  type DevDaemonConfig
} from './src/runtime/dev-proxy-target.js';
import {
  resolveDevDaemonLaunch
} from './src/runtime/dev-daemon-launch.js';
import {
  withDevelopmentRuntime
} from './src/runtime/development-runtime-env.js';

type RuntimeConfig = DevDaemonConfig;

type RuntimeProcess = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  config: Promise<RuntimeConfig>;
};

let runtimeProcess: RuntimeProcess | undefined;
const MAX_RUNTIME_OUTPUT_BUFFER = 1024 * 1024;
const DESKTOP_HOSTED = process.env.CLAWEE_WEB_DESKTOP_HOSTED === '1';

export default defineConfig({
  define: {
    __CLAWEE_APP_VERSION__: JSON.stringify(claweeAppVersion)
  },
  plugins: [
    react(),
    ...(DESKTOP_HOSTED ? [] : [claweeRuntimeDevPlugin()])
  ],
  server: {
    host: '0.0.0.0',
    port: 19_860,
    strictPort: true
  },
  preview: {
    host: '0.0.0.0',
    port: 4173
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll('\\', '/');
          if (
            normalized.includes('/node_modules/react/')
            || normalized.includes('/node_modules/react-dom/')
            || normalized.includes('/node_modules/react-router/')
            || normalized.includes('/node_modules/react-router-dom/')
            || normalized.includes('/node_modules/@remix-run/router/')
            || normalized.includes('/node_modules/react-virtuoso/')
            || normalized.includes('/node_modules/scheduler/')
          ) {
            return 'react-vendor';
          }
        }
      }
    }
  }
});

function claweeRuntimeDevPlugin(): Plugin {
  return {
    name: 'clawee-runtime-dev',
    configureServer(server) {
      server.middlewares.use('/.clawee/runtime-config', async (_request, response) => {
        try {
          const config = await getRuntimeConfig();
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({ baseUrl: DEV_RUNTIME_PROXY_BASE }));
        } catch (error) {
          response.statusCode = 503;
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({
            error: {
              code: 'RUNTIME_START_FAILED',
              message: error instanceof Error ? error.message : String(error)
            }
          }));
        }
      });

      server.middlewares.use(DEV_RUNTIME_PROXY_BASE, async (request, response) => {
        try {
          const config = await getRuntimeConfig();
          proxyRuntimeRequest(config, request, response);
        } catch (error) {
          response.statusCode = 503;
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({
            error: {
              code: 'RUNTIME_PROXY_FAILED',
              message: error instanceof Error ? error.message : String(error)
            }
          }));
        }
      });

      server.httpServer?.once('close', () => {
        runtimeProcess?.child.kill();
        runtimeProcess = undefined;
      });
    }
  };
}

function getRuntimeConfig(): Promise<RuntimeConfig> {
  runtimeProcess ??= startRuntimeProcess();
  return runtimeProcess.config;
}

function startRuntimeProcess(): RuntimeProcess {
  const pnpmScript = process.env.npm_execpath;
  const launch = resolveDevDaemonLaunch(process.env);
  const runtimeEnv = withDevelopmentRuntime(launch.env, {
    useProvidedDescriptor: launch.script === 'dev:e2e'
  });
  const scriptArgs = [
    '--filter',
    '@clawee/daemon',
    launch.script,
    ...(launch.runtimeArgs.length === 0
      ? []
      : ['--', ...launch.runtimeArgs])
  ];
  const directDaemonLaunch = pnpmScript === undefined;
  const daemonDir = resolve(process.cwd(), '../daemon');
  const args = directDaemonLaunch
    ? [
        '--import',
        'tsx',
        resolve(daemonDir, 'src/main.ts'),
        ...(launch.script === 'dev'
          ? [
              '--clawee-enterprise-config=.runtime/config.toml'
            ]
          : []),
        ...launch.runtimeArgs
      ]
    : [pnpmScript, ...scriptArgs];
  const child = spawn(process.execPath, args, {
    cwd: directDaemonLaunch ? daemonDir : process.cwd(),
    env: runtimeEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let runtimeReady = false;

  const config = new Promise<RuntimeConfig>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(
        `Runtime did not print connection config in time. ${
          runtimeStartupDiagnostics(stdout, stderr)
        }`.trim()
      ));
    }, 30_000);

    const rejectOnce = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = boundedAppend(stdout, chunk);
      const parsed = parseRuntimeConfigFromOutput(stdout);
      if (parsed !== null) {
        clearTimeout(timeout);
        runtimeReady = true;
        stdout = '';
        stderr = '';
        resolve(parsed);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (!runtimeReady) {
        stderr = boundedAppend(stderr, chunk);
        return;
      }
      process.stderr.write(`[daemon] ${chunk}`);
    });

    child.on('error', error => {
      rejectOnce(error);
    });

    child.on('exit', code => {
      if (code !== null && code !== 0) {
        rejectOnce(new Error(
          `Runtime exited with code ${code}. ${
            runtimeStartupDiagnostics(stdout, stderr)
          }`.trim()
        ));
      }
    });
  });

  return { child, config };
}

function runtimeStartupDiagnostics(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}

function parseRuntimeConfigFromOutput(output: string): RuntimeConfig | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.address !== 'string' || typeof record.token !== 'string') continue;
      return parseDevDaemonConfig({
        address: record.address,
        token: record.token
      });
    } catch {
      continue;
    }
  }

  return null;
}

function proxyRuntimeRequest(
  config: RuntimeConfig,
  incoming: import('node:http').IncomingMessage,
  outgoing: import('node:http').ServerResponse
) {
  const incomingUrl = incoming.url ?? '/';
  const fullRuntimeUrl = incomingUrl.startsWith(DEV_RUNTIME_PROXY_BASE)
    ? incomingUrl
    : `${DEV_RUNTIME_PROXY_BASE}${incomingUrl.startsWith('/') ? '' : '/'}${incomingUrl}`;
  const target = buildDevProxyTarget(config.baseUrl, fullRuntimeUrl);
  const headers = { ...incoming.headers };
  for (const name of ['authorization', 'host', 'origin', 'referer', 'connection']) {
    delete headers[name];
  }
  headers.authorization = `Bearer ${config.token}`;

  const proxyRequest = httpRequest(
    target,
    {
      method: incoming.method,
      headers
    },
    proxyResponse => {
      outgoing.statusCode = proxyResponse.statusCode ?? 502;
      for (const [name, value] of Object.entries(proxyResponse.headers)) {
        if (value !== undefined) outgoing.setHeader(name, value);
      }
      proxyResponse.pipe(outgoing);
    }
  );

  proxyRequest.on('error', error => {
    if (outgoing.headersSent) {
      outgoing.destroy(error);
      return;
    }

    outgoing.statusCode = 502;
    outgoing.setHeader('Content-Type', 'application/json');
    outgoing.end(JSON.stringify({
      error: {
        code: 'RUNTIME_PROXY_FAILED',
        message: error.message
      }
    }));
  });

  incoming.pipe(proxyRequest);
}

function boundedAppend(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_RUNTIME_OUTPUT_BUFFER
    ? next
    : next.slice(-MAX_RUNTIME_OUTPUT_BUFFER);
}
