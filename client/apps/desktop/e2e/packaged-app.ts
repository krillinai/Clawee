import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INCIDENT_LOG_MAX_BYTES, type AutomaticIncident } from '@clawee/protocol';
import {
  chromium,
  type Browser,
  type Page
} from '@playwright/test';

export type PackagedApp = {
  browser: Browser;
  page: Page;
  process: ChildProcess;
  executablePath: string;
  launchArgs: string[];
  env: NodeJS.ProcessEnv;
};

const incidentReceivers = new Map<string, string>();

export async function createPackagedIncidentReceiver(userData: string, policy?: { enabled: boolean; expires_at?: string }) {
  let requestCount = 0;
  const snapshots: AutomaticIncident[] = [];
  const logs: Array<{ incident_id: string; content: string }> = [];
  const server = createHttpServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/v1/feedback/policy') {
      response.writeHead(policy ? 200 : 503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: policy ? { enabled: policy.enabled, policy_version: 1, expires_at: policy.expires_at ?? new Date(Date.now() + 3_600_000).toISOString() } : undefined }));
      return;
    }
    requestCount++;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const logMatch = /^\/api\/v1\/feedback\/incidents\/([a-f0-9-]{36})\/logs$/.exec(request.url ?? '');
      if (logMatch) {
        const id = logMatch[1]!;
        if (request.method !== 'PUT' || !snapshots.some(snapshot => snapshot.incident_id === id) || Buffer.byteLength(body) > INCIDENT_LOG_MAX_BYTES
          || request.headers['x-content-sha256'] !== createHash('sha256').update(body).digest('hex')) throw new Error('invalid_logs');
        for (const line of body.trimEnd().split('\n')) JSON.parse(line);
        logs.push({ incident_id: id, content: body });
        response.writeHead(201, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: { received: true } })); return;
      }
      const snapshot = JSON.parse(body) as AutomaticIncident;
      if (request.method !== 'PUT' || request.url !== `/api/v1/feedback/incidents/${snapshot.incident_id}`) throw new Error('invalid_request');
      snapshots.push(snapshot);
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: { incident_id: snapshot.incident_id, accepted_revision: snapshot.revision } }));
    } catch { response.writeHead(400); response.end(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Incident receiver address is unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  incidentReceivers.set(userData, origin);
  return {
    origin,
    get requestCount() { return requestCount; },
    snapshots,
    logs,
    async close() {
      incidentReceivers.delete(userData);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

export async function launchPackagedApp(input: {
  executablePath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<PackagedApp> {
  const userData = input.args.find(value => value.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  if (userData) {
    mkdirSync(userData, { recursive: true });
    const incidentsPath = join(userData, 'auto-incidents.json');
    if (!existsSync(incidentsPath)) writeFileSync(incidentsPath, JSON.stringify({ installationId: randomUUID(), enabled: false, notified: true, noticeVersion: 2, records: [] }), { mode: 0o600 });
  }
  const incidentOrigin = userData === undefined ? undefined : incidentReceivers.get(userData);
  const env = { ...input.env, ...(incidentOrigin === undefined ? {} : { CLAWEE_E2E_INCIDENT_ORIGIN: incidentOrigin }) };
  const timeoutMs = input.timeoutMs ?? 30_000;
  const port = await reservePort();
  const launchArgs = [
    ...input.args,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`
  ];
  const child = spawn(input.executablePath, launchArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  });
  const diagnostics = collectDiagnostics(child);

  try {
    await waitForCdp(port, child, timeoutMs, diagnostics);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (context === undefined) {
      throw new Error('Desktop CDP connection did not expose a browser context');
    }
    let page = context.pages()[0];
    if (page === undefined) {
      try {
        page = await context.waitForEvent('page', { timeout: timeoutMs });
      } catch (error) {
        throw new Error(
          `Desktop page did not become ready within ${timeoutMs}ms\n`
          + diagnostics(),
          { cause: error }
        );
      }
    }
    return {
      browser,
      page,
      process: child,
      executablePath: input.executablePath,
      launchArgs: input.args,
      env
    };
  } catch (error) {
    await terminateProcessTree(child);
    throw error;
  }
}

export async function launchSecondInstance(
  app: PackagedApp,
  extraArgs: string[] = []
): Promise<void> {
  const child = spawn(app.executablePath, [...app.launchArgs, ...extraArgs], {
    env: app.env,
    stdio: 'ignore',
    windowsHide: true
  });
  const exited = await waitForProcessExit(child, 10_000);
  if (!exited) {
    await terminateProcessTree(child);
    throw new Error('Desktop second instance did not exit after handing off');
  }
}

export async function relaunchPackagedApp(
  app: Pick<PackagedApp, 'executablePath' | 'launchArgs' | 'env'>,
  timeoutMs = 30_000
): Promise<PackagedApp> {
  return launchPackagedApp({
    executablePath: app.executablePath,
    args: app.launchArgs,
    env: app.env,
    timeoutMs
  });
}

export async function waitForPackagedPage(
  app: PackagedApp,
  timeoutMs = 15_000
): Promise<Page> {
  const context = app.browser.contexts()[0];
  if (context === undefined) {
    throw new Error('Desktop CDP browser context is unavailable');
  }
  const existing = context.pages().find(page => !page.isClosed());
  if (existing !== undefined) return existing;
  return await context.waitForEvent('page', { timeout: timeoutMs });
}

export async function closePackagedApp(app: PackagedApp): Promise<void> {
  await app.page.evaluate(() => {
    const desktopWindow = window as Window & {
      claweeDesktop?: { quit(): Promise<void> };
    };
    void desktopWindow.claweeDesktop?.quit();
  }).catch(() => undefined);
  const exited = await waitForProcessExit(app.process, 8_000);
  if (!exited) await terminateProcessTree(app.process);
  await app.browser.close().catch(() => undefined);
}

export async function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise(resolve => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    child.once('exit', onExit);
  });
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve a Desktop CDP port'));
        return;
      }
      server.close(error => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForCdp(
  port: number,
  child: ChildProcess,
  timeoutMs: number,
  diagnostics: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Desktop exited before CDP became ready: `
        + `exit=${String(child.exitCode)} signal=${String(child.signalCode)}\n`
        + diagnostics()
      );
    }
    const ready = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then(response => response.ok)
      .catch(() => false);
    if (ready) return;
    await delay(100);
  }
  throw new Error(`Desktop CDP did not become ready within ${timeoutMs}ms\n${diagnostics()}`);
}

function collectDiagnostics(child: ChildProcess): () => string {
  let output = '';
  const append = (chunk: Buffer | string) => {
    output += chunk.toString();
    if (output.length > 64 * 1024) output = output.slice(-64 * 1024);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true }
      );
      killer.once('error', () => resolve(undefined));
      killer.once('exit', () => resolve(undefined));
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  if (await waitForProcessExit(child, 2_000)) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The process group exited during the grace period.
  }
  await waitForProcessExit(child, 2_000);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
