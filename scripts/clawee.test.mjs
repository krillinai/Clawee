import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(resolve('client/apps/daemon/package.json'));
const yaml = require('yaml');
const run = (...args) => spawnSync(process.execPath, ['scripts/clawee.mjs', 'init', ...args], { encoding: 'utf8' });

test('初始化生成独立密钥、外部数据路径，重复执行不覆盖配置', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-init-'));
  try {
    const args = ['--ops-dir', directory, '--gateway', 'https://gateway.example'];
    const first = run(...args);
    assert.equal(first.status, 0, first.stderr);
    const path = join(directory, 'configs/config.yaml');
    const raw = readFileSync(path, 'utf8');
    const config = yaml.parse(raw);
    assert.equal(config.model_access.mode, 'enterprise_managed');
    assert.equal(config.security.agent_token_encryption_key.length, 32);
    assert.equal(config.security.user_jwt_signing_key.length, 64);
    assert.notEqual(config.security.user_jwt_signing_key, config.security.agent_token_encryption_key);
    assert.equal(config.mcp.public_base_url, 'https://gateway.example');
    assert.equal(config.security.session_cookie_secure, true);
    assert.ok(config.shared_files.storage_root.startsWith(directory));
    assert.equal(run(...args).status, 0);
    assert.equal(readFileSync(path, 'utf8'), raw);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('拒绝向源码目录生成凭据', () => {
  assert.notEqual(run('--ops-dir', resolve('.runtime/ops')).status, 0);
});

test('容器初始化生成数据库密码和容器内持久化路径', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-container-init-'));
  try {
    const result = run('--ops-dir', directory, '--container');
    assert.equal(result.status, 0, result.stderr);
    const config = yaml.parse(readFileSync(join(directory, 'configs/config.yaml'), 'utf8'));
    const env = readFileSync(join(directory, '.env'), 'utf8');
    const password = env.trim().split('=')[1];
    assert.equal(password.length, 64);
    assert.equal(new URL(config.database.url).password, password);
    assert.equal(new URL(config.database.url).hostname, 'postgres');
    assert.equal(config.server.addr, '0.0.0.0:1904');
    assert.equal(config.shared_files.storage_root, '/app/data/shared-files');
    assert.equal(run('--ops-dir', directory, '--container').status, 0);
    assert.equal(readFileSync(join(directory, '.env'), 'utf8'), env);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('拒绝含凭据的 Gateway URL', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-invalid-init-'));
  try { assert.notEqual(run('--ops-dir', directory, '--gateway', 'https://user:password@gateway.example').status, 0); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test('拒绝通过外部符号链接向源码目录写入凭据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-symlink-init-'));
  try {
    symlinkSync(resolve('.'), join(directory, 'configs'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.notEqual(run('--ops-dir', directory).status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
