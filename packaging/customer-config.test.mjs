import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { join } from 'node:path';
import { root, selectCustomer } from './customer-config.mjs';

const require = createRequire(join(root, 'client/apps/desktop/package.json'));
const { parse } = require('@iarna/toml');

test('两个示例客户仅生成自身 Gateway，不包含清单或身份', () => {
  const customers = JSON.parse(readFileSync(join(root, 'customers.json'), 'utf8'));
  for (const id of ['demo', 'customer-a']) {
    const selected = selectCustomer(customers, id);
    assert.deepEqual(parse(selected.contents), { gateway: customers[id].gateway });
    assert.match(selected.configSha256, /^[a-f0-9]{64}$/);
  }
});

test('客户精确查找拒绝未知 ID、继承属性、路径和 shell 输入', () => {
  for (const id of ['unknown', '__proto__', 'constructor', '../demo', 'demo\n', '$(env)', 'demo;id', '']) {
    assert.throws(() => selectCustomer({ demo: { gateway: 'https://gateway.example.com' } }, id));
  }
  assert.throws(() => selectCustomer(Object.create({ demo: { gateway: 'https://gateway.example.com' } }), 'demo'));
});

test('客户 Gateway 拒绝不安全传输及非 origin 输入', () => {
  for (const gateway of ['', 'http://gateway.example.com', 'https://localhost', 'https://foo.localhost', 'https://localhost.', 'https://127.0.0.2', 'https://2130706433', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://user:secret@example.com', 'https://@example.com', 'https://example.com/api', 'https://example.com/a/..', 'https://example.com?', 'https://example.com#', 'https://example.com?token=secret', 'https://example.com/#fragment', ' https://example.com', 'https://example.com\\']) {
    assert.throws(() => selectCustomer({ demo: { gateway } }, 'demo'), gateway);
  }
  assert.throws(() => selectCustomer({ demo: { gateway: 'https://example.com', token: 'secret' } }, 'demo'));
  assert.equal(selectCustomer({ demo: { gateway: 'https://gateway.example.com:8443/' } }, 'demo').gateway, 'https://gateway.example.com:8443');
});

test('临时 TOML 注入不改变 Git 状态，未知客户生成失败', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-customer-injection-'));
  const { GITHUB_ENV, GITHUB_OUTPUT, CUSTOMER_SHA, ...env } = process.env;
  const status = () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).stdout;
  const before = status();
  try {
    const result = spawnSync(process.execPath, ['packaging/customer-config.mjs', 'generate', 'demo'], {
      cwd: root, env: { ...env, RUNNER_TEMP: directory }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parse(readFileSync(result.stdout.trim(), 'utf8')), { gateway: 'https://gateway.demo.example.com' });
    const invalid = spawnSync(process.execPath, ['packaging/customer-config.mjs', 'generate', 'missing-customer'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.equal(status(), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
