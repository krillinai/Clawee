import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  assertReleaseSupportsBundledRuntime,
  inspectReleaseVersion,
  parseReleaseVersion,
  setReleaseVersion
} from './release-version.mjs';

test('读取统一产品版本并校验内嵌 Runtime 下限', () => {
  assert.deepEqual(inspectReleaseVersion(), {
    version: '0.1.9',
    tag: 'v0.1.9',
    prerelease: false,
    channel: 'stable'
  });
});

test('区分稳定版本和候选版本', () => {
  assert.equal(parseReleaseVersion('0.1.0').channel, 'stable');
  assert.deepEqual(parseReleaseVersion('0.2.0-rc.1'), {
    version: '0.2.0-rc.1',
    tag: 'v0.2.0-rc.1',
    prerelease: true,
    channel: 'prerelease'
  });
  assert.throws(() => parseReleaseVersion('0.2.0-rc.01'));
  assert.throws(() => parseReleaseVersion('v0.2.0'));
});

test('发布版本必须满足内嵌 Runtime 的最低 Clawee 版本', () => {
  assert.doesNotThrow(
    () => assertReleaseSupportsBundledRuntime('0.1.0', '0.1.0')
  );
  assert.doesNotThrow(
    () => assertReleaseSupportsBundledRuntime('0.2.0', '0.1.0')
  );
  assert.doesNotThrow(
    () => assertReleaseSupportsBundledRuntime(
      '0.2.0-alpha-beta.2',
      '0.2.0-alpha-beta.1'
    )
  );
  assert.throws(
    () => assertReleaseSupportsBundledRuntime('0.1.0-rc.1', '0.1.0'),
    /below bundled Runtime minimum/
  );
  assert.throws(
    () => assertReleaseSupportsBundledRuntime('0.1.0', '1.0.0'),
    /below bundled Runtime minimum/
  );
});

test('发布检查以 Tag 作为正式版本来源', () => {
  const result = spawnSync(process.execPath, [
    'scripts/release-version.mjs',
    'check',
    '--tag',
    'v0.2.0'
  ], {
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"version":"0\.2\.0"/);
});

test('发布检查拒绝非 SemVer Tag', () => {
  const result = spawnSync(process.execPath, [
    'scripts/release-version.mjs', 'check', '--tag', 'main'
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid release tag/);
});

test('设置发布版本只写入 VERSION 文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-release-version-'));
  try {
    writeFixture(
      root,
      'client/config/codex-runtime.json',
      '{"minimumClaweeVersion":"0.1.0"}\n'
    );
    assert.deepEqual(setReleaseVersion('0.2.0', root), ['VERSION']);
    assert.equal(readFileSync(join(root, 'VERSION'), 'utf8'), '0.2.0\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFixture(root, path, content) {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}
