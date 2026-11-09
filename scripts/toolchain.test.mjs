import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifestPaths = [
  'package.json',
  'client/package.json',
  'server/web/package.json'
];

const manifests = manifestPaths.map((path) => ({
  path,
  value: JSON.parse(readFileSync(path, 'utf8'))
}));

test('根目录、客户端与管理台使用同一 pnpm 版本', () => {
  const expected = manifests[0].value.packageManager;
  assert.match(expected, /^pnpm@\d+\.\d+\.\d+$/);
  for (const manifest of manifests.slice(1)) {
    assert.equal(manifest.value.packageManager, expected, manifest.path);
  }
});

test('客户端显式放行 pnpm 10 所需的依赖构建脚本', () => {
  const client = manifests.find(({ path }) => path === 'client/package.json').value;
  const allowed = new Set(client.pnpm?.onlyBuiltDependencies);
  for (const dependency of ['better-sqlite3', 'electron-winstaller', 'esbuild']) {
    assert.ok(allowed.has(dependency), dependency);
  }
});

test('根目录客户端入口执行仓库锁定版本的 pnpm', () => {
  const result = spawnSync(process.execPath, [
    'scripts/clawee.mjs', 'client', '--version'
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout.trim(), manifests[0].value.packageManager.split('@')[1]);
});

test('根目录客户端入口保留带空格的参数', () => {
  const argument = 'a path with spaces';
  const result = spawnSync(process.execPath, [
    'scripts/clawee.mjs', 'client', 'exec', 'node', '--eval',
    'process.stdout.write(process.argv[1])', argument
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, argument);
});
