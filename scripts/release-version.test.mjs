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
  releasePackagePaths,
  setReleaseVersion
} from './release-version.mjs';

test('统一发布版本与所有产品版本标记一致', () => {
  assert.deepEqual(inspectReleaseVersion(), {
    version: '0.1.0',
    tag: 'v0.1.0',
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

test('发布检查拒绝与版本不一致的 Tag', () => {
  const result = spawnSync(process.execPath, [
    'scripts/release-version.mjs',
    'check',
    '--tag',
    'v9.9.9'
  ], {
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match version 0\.1\.0/);
});

test('版本目标校验失败时不写入部分文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-release-version-'));
  try {
    for (const path of releasePackagePaths) {
      writeFixture(root, path, '{"version":"0.1.0"}\n');
    }
    writeFixture(
      root,
      'client/config/codex-runtime.json',
      '{"minimumClaweeVersion":"0.1.0"}\n'
    );
    writeFixture(
      root,
      'deploy/docker-compose.yml',
      'image: ghcr.io/krillinai/clawee-server:${CLAWEE_VERSION:-0.1.0}\n'
    );
    writeFixture(
      root,
      'server/Dockerfile',
      'ARG CLAW_MCP_VERSION=0.1.0\n'
    );
    writeFixture(
      root,
      'server/internal/buildinfo/buildinfo.go',
      'var Version = "0.1.0"\n'
    );
    writeFixture(
      root,
      'server/scripts/buildinfo-ldflags.sh',
      'missing version marker\n'
    );

    assert.throws(
      () => setReleaseVersion('0.2.0', root),
      /Unable to update version marker/
    );
    assert.equal(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
      '0.1.0'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFixture(root, path, content) {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}
