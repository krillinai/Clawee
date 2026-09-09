import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildReleaseManifest } from './build-release-manifest.mjs';

test('生成统一发布清单和校验文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-release-manifest-'));
  try {
    const artifacts = join(root, 'artifacts');
    const output = join(root, 'output');
    mkdirSync(join(artifacts, 'desktop'), { recursive: true });
    mkdirSync(join(artifacts, 'server'), { recursive: true });
    writeFileSync(join(artifacts, 'desktop', 'Clawee-0.1.0.dmg'), 'desktop');
    writeFileSync(
      join(artifacts, 'server', 'clawee-server-v0.1.0-linux-amd64.tar.gz'),
      'server'
    );

    const result = buildReleaseManifest({
      artifactDirectory: artifacts,
      outputDirectory: output,
      version: '0.1.0',
      tag: 'v0.1.0',
      commit: 'a'.repeat(40),
      image: 'ghcr.io/krillinai/clawee-server',
      imageDigest: `sha256:${'b'.repeat(64)}`
    });

    assert.equal(result.manifest.prerelease, false);
    assert.equal(result.manifest.desktop.windowsSigning, 'unsigned');
    assert.deepEqual(
      result.manifest.artifacts.map(artifact => artifact.name),
      ['Clawee-0.1.0.dmg', 'clawee-server-v0.1.0-linux-amd64.tar.gz']
    );
    assert.match(readFileSync(result.checksumsPath, 'utf8'), /release-manifest\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拒绝候选版本冒充稳定 Tag', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-release-manifest-invalid-'));
  try {
    writeFileSync(join(root, 'artifact.bin'), 'artifact');
    assert.throws(() => buildReleaseManifest({
      artifactDirectory: root,
      version: '0.2.0-rc.1',
      tag: 'v0.2.0',
      commit: 'a'.repeat(40),
      image: 'ghcr.io/krillinai/clawee-server',
      imageDigest: `sha256:${'b'.repeat(64)}`
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
