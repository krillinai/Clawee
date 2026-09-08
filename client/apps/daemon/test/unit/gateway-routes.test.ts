import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registerGatewayRoutes } from '../../src/api/routes.gateway.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(canChange = true, failClear = false) {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-gateway-test-'));
  const configPath = join(directory, 'config.toml');
  writeFileSync(configPath, 'gateway = "https://old.example"\n');
  let origin = 'https://old.example';
  const clearSession = vi.fn(async () => { if (failClear) throw new Error('storage unavailable'); });
  const activate = vi.fn((next: string) => { origin = next; });
  const server = Fastify();
  await registerGatewayRoutes(server, { configPath, getOrigin: () => origin, canChange: () => canChange, clearSession, activate });
  cleanup.push(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { server, configPath, clearSession, activate };
}

it('保存前清除旧认证，然后激活新网关', async () => {
  const f = await fixture();
  const reply = await f.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: { gateway: 'https://new.example/' } });
  expect(reply.statusCode).toBe(200);
  expect(f.clearSession).toHaveBeenCalledOnce();
  expect(f.activate).toHaveBeenCalledWith('https://new.example');
  expect(readFileSync(f.configPath, 'utf8')).toContain('https://new.example');
  expect((await f.server.inject('/enterprise/gateway')).json().gateway).toBe('https://new.example');
});

it.each(['http://remote.example', 'https://user:secret@example.com', 'https://example.com/path', 'file:///tmp'])('拒绝不安全网关 %s', async gateway => {
  const f = await fixture();
  expect((await f.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: { gateway } })).statusCode).toBe(400);
  expect(f.clearSession).not.toHaveBeenCalled();
});

it('会话或任务忙时不更改配置', async () => {
  const f = await fixture(false);
  expect((await f.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: { gateway: 'https://new.example' } })).statusCode).toBe(409);
  expect(f.clearSession).not.toHaveBeenCalled();
});

it('凭据清理失败时保留原网关', async () => {
  const f = await fixture(true, true);
  expect((await f.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: { gateway: 'https://new.example' } })).statusCode).toBe(500);
  expect(f.activate).not.toHaveBeenCalled();
  expect(readFileSync(f.configPath, 'utf8')).toContain('https://old.example');
});
