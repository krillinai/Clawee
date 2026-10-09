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

it('允许保存远程 HTTP 网关', async () => {
  const f = await fixture();
  const reply = await f.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: { gateway: 'http://remote.example:1904/' } });
  expect(reply.statusCode).toBe(200);
  expect(f.clearSession).toHaveBeenCalledOnce();
  expect(f.activate).toHaveBeenCalledWith('http://remote.example:1904');
  expect(readFileSync(f.configPath, 'utf8')).toContain('http://remote.example:1904');
});

it.each(['https://user:secret@example.com', 'https://example.com/path', 'file:///tmp'])('拒绝无效网关 %s', async gateway => {
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

it('兼容旧配置并保留多个已保存地址', async () => {
  const testFixture = await fixture();
  expect((await testFixture.server.inject('/enterprise/gateway')).json().gateways).toEqual(['https://old.example']);
  const reply = await testFixture.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: { gateway: 'https://new.example' } });
  expect(reply.json().gateways).toEqual(['https://old.example', 'https://new.example']);
  expect((await testFixture.server.inject('/enterprise/gateway')).json().gateways).toEqual(reply.json().gateways);
});

it('登录后可编辑列表且不清除会话或切换当前服务器', async () => {
  const testFixture = await fixture(false);
  const reply = await testFixture.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: {
    gateway: 'https://old.example',
    gateways: ['https://old.example/', 'https://other.example/', 'https://other.example']
  } });
  expect(reply.statusCode).toBe(200);
  expect(reply.json().gateways).toEqual(['https://old.example', 'https://other.example']);
  expect(testFixture.clearSession).not.toHaveBeenCalled();
  expect(testFixture.activate).not.toHaveBeenCalled();
  expect((await testFixture.server.inject('/enterprise/gateway')).json().gateways).toEqual(reply.json().gateways);
});

it.each([
  ['https://old.example', 'file:///tmp'],
  ['https://old.example', 'https://user:secret@example.com'],
  ['https://other.example']
])('拒绝无效列表或删除当前服务器 %j', async (...gateways) => {
  const testFixture = await fixture(false);
  expect((await testFixture.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: {
    gateway: 'https://old.example', gateways
  } })).statusCode).toBe(400);
  expect(testFixture.clearSession).not.toHaveBeenCalled();
});

it('没有配置时返回空列表且可保存第一个地址', async () => {
  const testFixture = await fixture();
  writeFileSync(testFixture.configPath, 'gateway = "https://enterprise.invalid"\n');
  testFixture.activate('https://enterprise.invalid');
  expect((await testFixture.server.inject('/enterprise/gateway')).json()).toEqual({ gateway: '', gateways: [], configurable: true });
  const reply = await testFixture.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: { gateway: 'https://first.example' } });
  expect(reply.statusCode).toBe(200);
  expect(reply.json().gateways).toEqual(['https://first.example']);
});

it('配置文件不存在时创建本地配置', async () => {
  const testFixture = await fixture();
  rmSync(testFixture.configPath);
  testFixture.activate('https://enterprise.invalid');
  expect((await testFixture.server.inject('/enterprise/gateway')).json().gateways).toEqual([]);
  const reply = await testFixture.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: { gateway: 'https://first.example' } });
  expect(reply.statusCode).toBe(200);
  expect(readFileSync(testFixture.configPath, 'utf8')).toContain('https://first.example');
});

it('重新注册服务后从磁盘恢复服务器列表和当前选择', async () => {
  const testFixture = await fixture();
  await testFixture.server.inject({ method: 'POST', url: '/enterprise/gateway', payload: { gateway: 'https://new.example' } });
  const restarted = Fastify();
  await registerGatewayRoutes(restarted, {
    configPath: testFixture.configPath, getOrigin: () => 'https://new.example', canChange: () => true,
    clearSession: async () => undefined, activate: () => undefined
  });
  cleanup.push(() => restarted.close());
  expect((await restarted.inject('/enterprise/gateway')).json()).toEqual({
    gateway: 'https://new.example', gateways: ['https://old.example', 'https://new.example'], configurable: true
  });
});
