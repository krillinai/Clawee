import assert from 'node:assert/strict';
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
