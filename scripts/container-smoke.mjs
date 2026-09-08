import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMcpPermissions } from './mcp-smoke.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = createRequire(join(root, 'client/apps/daemon/package.json'))('yaml');
const directory = mkdtempSync(join(tmpdir(), 'clawee-container-smoke-'));
const project = `clawee-smoke-${randomBytes(5).toString('hex')}`;
const configFile = join(directory, 'compose.json');
const env = { ...process.env, CLAWEE_OPS_DIR: directory };
function run(command, args, extraEnv = {}, timeout = 120000) {
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} 执行失败（输出可能含配置，未回显）`);
  return result.stdout;
}
const compose = (...args) => run('docker', ['compose', '--project-name', project, '--env-file', join(directory, '.env'), '-f', configFile, ...args]);
try {
  run(process.execPath, ['scripts/clawee.mjs', 'init', '--ops-dir', directory, '--container']);
  // 测试密钥只存在于权限为 0700 的临时目录，放宽单个挂载文件供容器非 root 用户读取。
  chmodSync(join(directory, 'configs/config.yaml'), 0o444);
  const specification = yaml.parse(readFileSync(join(root, 'deploy/docker-compose.yml'), 'utf8'));
  delete specification.name;
  delete specification.services.gateway.build;
  specification.services.gateway.image = process.env.CLAWEE_TEST_IMAGE ?? 'clawee-server:oss-local';
  specification.services.gateway.ports = ['127.0.0.1::1904'];
  specification.services.gateway.extra_hosts = ['host.docker.internal:host-gateway'];
  writeFileSync(configFile, JSON.stringify(specification), { mode: 0o600 });
  compose('up', '-d', '--wait', 'postgres');
  compose('run', '--rm', '--no-deps', 'gateway', 'migrate', 'up');
  compose('up', '-d', 'gateway');
  const readOrigin = () => `http://127.0.0.1:${compose('port', 'gateway', '1904').trim().split(':').at(-1)}`;
  let origin = readOrigin();
  async function waitReady() {
    for (let attempt = 0; ; attempt++) {
      const ready = await fetch(`${origin}/readyz`).then(r => r.ok).catch(() => false);
      if (ready) return;
      if (attempt >= 30) throw new Error('Gateway 未就绪');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  await waitReady();
  async function request(path, payload, token) {
    const response = await fetch(origin + path, {
      method: payload ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {})
    });
    assert.equal(response.status, 200, `${path} HTTP ${response.status}`);
    return { ...(await response.json()), cookies: response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ') };
  }
  const account = { email: 'smoke@example.test', name: 'Smoke Admin', password: randomBytes(24).toString('hex') };
  const registered = await request('/api/v1/auth/register', account);
  assert.equal(registered.data.applications.admin, true);
  const admin = await request('/api/v1/auth/login', account);
  const login = await request('/api/v1/auth/login', { ...account, client_id: 'clawee-agent', agent_id: 'clawee_550e8400-e29b-41d4-a716-446655440000' });
  const token = login.data.access_token;
  assert.equal(typeof token, 'string');
  const me = await request('/api/v1/auth/me', undefined, token);
  assert.ok(me.data);
  await verifyMcpPermissions(origin, admin.cookies, me.data.account.user_id, 'clawee_550e8400-e29b-41d4-a716-446655440000');
  const mode = await request('/api/v1/app/model-configuration', {}, token);
  assert.equal(mode.data.mode, 'enterprise_managed');
  if (process.env.CLAWEE_EXTERNAL_MODEL_CONFIG) {
    const stackPath = join(directory, 'external-stack.json');
    writeFileSync(stackPath, JSON.stringify({ gateway: origin, email: account.email, password: account.password }), { mode: 0o600 });
    run(process.execPath, ['scripts/clawee.mjs', 'client', '--filter', '@clawee/desktop', 'exec', 'playwright', 'test', '--config', 'playwright.external.config.ts'], {
      CLAWEE_EXTERNAL_MODEL_CONFIG: resolve(process.env.CLAWEE_EXTERNAL_MODEL_CONFIG),
      CLAWEE_EXTERNAL_STACK_CONFIG: stackPath,
      CLAWEE_E2E_RUNTIME_ROOT: directory
    }, 360000);
    console.log('真实模型验证通过：隔离桌面登录、自带模型配置、包内 Runtime 任务与页面回复。');
  }
  compose('restart', 'gateway');
  origin = readOrigin();
  await waitReady();
  const restored = await request('/api/v1/auth/me', undefined, token);
  assert.ok(restored.data);
  console.log('容器验证通过：空库迁移、首个管理员、Agent 登录、自带模型模式与重启后会话持久化。');
} catch (error) {
  if (process.env.CLAWEE_TEST_LOG_DIR) {
    writeFileSync(join(process.env.CLAWEE_TEST_LOG_DIR, 'container-failure.log'), compose('logs', '--no-color'), { mode: 0o600 });
  }
  throw error;
} finally {
  try { compose('down', '--volumes', '--remove-orphans'); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
