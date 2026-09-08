import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexAppServerClient } from '../../src/codex/app-server-client.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Codex app-server client', () => {
  it('initializes lazily and reuses one process for concurrent requests', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-app-server-client-'));
    const codexBin = createFakeAppServer(tempDir);
    const client = createCodexAppServerClient({
      codexBin,
      codexHome: join(tempDir, 'codex-home'),
      requestTimeoutMs: 10_000
    });

    const [threads, search] = await Promise.all([
      client.request<{ data: unknown[] }>('thread/list', { limit: 50 }),
      client.request<{ data: unknown[] }>('thread/search', { searchTerm: '测试' })
    ]);

    expect(threads).toEqual({ data: [{ id: 'thread-1' }] });
    expect(search).toEqual({ data: [{ snippet: '测试' }] });
    await client.close();
    expect(readFileSync(join(tempDir, 'initializations.txt'), 'utf8')).toBe('1');
    expect(readFileSync(join(tempDir, 'requests.txt'), 'utf8').trim().split('\n')).toEqual([
      'thread/list',
      'thread/search'
    ]);
  });

  it('restarts the process after an initialization timeout', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-app-server-client-'));
    const codexBin = createTimeoutThenRecoverAppServer(tempDir);
    const client = createCodexAppServerClient({
      codexBin,
      codexHome: join(tempDir, 'codex-home'),
      requestTimeoutMs: 5_000
    });

    try {
      await expect(
        client.request('thread/list', { limit: 50 })
      ).rejects.toThrow('Codex app-server request timed out: initialize');

      await expect(
        client.request('thread/list', { limit: 50 })
      ).resolves.toEqual({ data: [{ id: 'thread-recovered' }] });
      expect(readFileSync(join(tempDir, 'initializations.txt'), 'utf8')).toBe('2');
    } finally {
      await client.close();
    }
  });

  it('includes bounded stderr diagnostics when startup fails', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-app-server-client-'));
    const client = createCodexAppServerClient({
      codexBin: createFailingAppServer(tempDir),
      codexHome: join(tempDir, 'codex-home'),
      requestTimeoutMs: 5_000
    });

    await expect(
      client.request('thread/list', { limit: 50 })
    ).rejects.toThrow(
      'Codex app-server closed with exit code 61: fatal app-server startup'
    );
  });
});

function createFakeAppServer(dir: string): string {
  const bin = join(dir, 'fake-codex.js');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const initPath = ${JSON.stringify(join(dir, 'initializations.txt'))};
const requestsPath = ${JSON.stringify(join(dir, 'requests.txt'))};
const rl = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    const count = fs.existsSync(initPath) ? Number(fs.readFileSync(initPath, 'utf8')) : 0;
    fs.writeFileSync(initPath, String(count + 1));
    send({ id: message.id, result: { userAgent: 'fake' } });
    return;
  }
  if (message.method === 'initialized') return;
  fs.appendFileSync(requestsPath, message.method + '\\n');
  if (message.method === 'thread/list') {
    send({ id: message.id, result: { data: [{ id: 'thread-1' }] } });
    return;
  }
  if (message.method === 'thread/search') {
    send({ id: message.id, result: { data: [{ snippet: message.params.searchTerm }] } });
  }
});
`, 'utf8');
  chmodSync(bin, 0o755);
  return bin;
}

function createTimeoutThenRecoverAppServer(dir: string): string {
  const bin = join(dir, 'fake-codex-timeout.js');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const initPath = ${JSON.stringify(join(dir, 'initializations.txt'))};
const count = fs.existsSync(initPath)
  ? Number(fs.readFileSync(initPath, 'utf8')) + 1
  : 1;
fs.writeFileSync(initPath, String(count));
if (count === 1) {
  process.stdin.resume();
} else {
  const rl = readline.createInterface({ input: process.stdin });
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  rl.on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'fake' } });
    } else if (message.method === 'thread/list') {
      send({
        id: message.id,
        result: { data: [{ id: 'thread-recovered' }] }
      });
    }
  });
}
`, 'utf8');
  chmodSync(bin, 0o755);
  return bin;
}

function createFailingAppServer(dir: string): string {
  const bin = join(dir, 'fake-codex-failure.js');
  writeFileSync(bin, `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', line => {
  const message = JSON.parse(line);
  process.stdin.destroy();
  process.stdout.write(JSON.stringify({
    id: message.id,
    result: { userAgent: 'fake' }
  }) + '\\n', () => {
    process.stderr.write('fatal app-server startup\\n');
    setTimeout(() => process.exit(61), 50);
  });
});
`, 'utf8');
  chmodSync(bin, 0o755);
  return bin;
}
