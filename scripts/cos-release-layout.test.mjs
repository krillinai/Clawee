import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertCanPromote,
  buildVersionsCatalog,
  prepareReleaseLayout,
  publicObjectUrl,
  validateCosConfiguration
} from './cos-release-layout.mjs';

const config = {
  bucket: 'clawee-release-1250000000',
  region: 'ap-guangzhou',
  publicBaseUrl: 'https://download.example.com',
  prefix: 'clawee'
};

test('校验 COS 配置和对象 URL', () => {
  assert.deepEqual(validateCosConfiguration(config), config);
  assert.equal(publicObjectUrl(config, 'releases/v1.0.0/a file.dmg'), 'https://download.example.com/clawee/releases/v1.0.0/a%20file.dmg');
  for (const invalid of [
    { ...config, publicBaseUrl: 'http://download.example.com' },
    { ...config, publicBaseUrl: 'https://download.example.com/' },
    { ...config, prefix: '../clawee' },
    { ...config, bucket: 'clawee-release' },
    { ...config, region: 'Guangzhou' }
  ]) assert.throws(() => validateCosConfiguration(invalid));
  assert.throws(() => publicObjectUrl(config, '../secret'));
});

test('生成稳定版目录、公开清单并结构化改写三种 updater feed', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-cos-layout-'));
  try {
    const artifacts = join(root, 'artifacts');
    mkdirSync(artifacts);
    const files = {
      'Clawee-1.2.3.dmg': 'dmg-x64',
      'Clawee-1.2.3.zip': 'zip-x64',
      'Clawee-1.2.3.zip.blockmap': 'blockmap-x64',
      'Clawee-1.2.3-arm64.dmg': 'dmg-arm64',
      'Clawee-1.2.3-arm64.zip': 'zip-arm64',
      'Clawee-1.2.3-arm64.zip.blockmap': 'blockmap-arm64',
      'Clawee-Setup-1.2.3.exe': 'exe',
      'Clawee-Setup-1.2.3.exe.blockmap': 'exe-map',
      'clawee-desktop-build-manifest-mac-x64.json': '{}',
      'clawee-desktop-build-manifest-mac-arm64.json': '{}',
      'clawee-desktop-build-manifest-win-x64.json': '{}',
      'clawee-server-v1.2.3-linux-amd64.tar.gz': 'server-amd64',
      'clawee-server-v1.2.3-linux-arm64.tar.gz': 'server-arm64',
      'server-linux-amd64-SHA256SUMS': 'sum-amd64',
      'server-linux-arm64-SHA256SUMS': 'sum-arm64',
      'latest-mac.yml': updater('1.2.3', 'Clawee-1.2.3.zip'),
      'latest-arm64-mac.yml': updater('1.2.3', 'Clawee-1.2.3-arm64.zip'),
      'latest.yml': updater('1.2.3', 'Clawee-Setup-1.2.3.exe')
    };
    for (const [name, value] of Object.entries(files)) writeFileSync(join(artifacts, name), value);
    const manifest = {
      schemaVersion: 1,
      product: 'Clawee',
      version: '1.2.3',
      tag: 'v1.2.3',
      commit: 'a'.repeat(40),
      desktop: { macosSigning: 'developer-id-notarized', windowsSigning: 'unsigned' },
      serverImage: { name: 'ghcr.io/krillinai/clawee-server', digest: `sha256:${'b'.repeat(64)}` },
      artifacts: Object.keys(files).map(name => details(artifacts, name))
    };
    const manifestPath = join(root, 'release-manifest.json');
    const notesPath = join(root, 'release-notes.md');
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    writeFileSync(notesPath, 'release notes');
    const result = prepareReleaseLayout({
      ...config,
      artifactDirectory: artifacts,
      outputDirectory: join(root, 'stage'),
      manifestPath,
      releaseNotesPath: notesPath,
      version: '1.2.3',
      tag: 'v1.2.3',
      commit: 'a'.repeat(40),
      publishedAt: '2026-09-10T10:00:00.000Z'
    });
    assert.equal(result.channel, 'stable');
    assert.equal(result.release.artifacts.length, Object.keys(files).length);
    assert.equal(result.release.serverImage.digest, `sha256:${'b'.repeat(64)}`);
    assert.equal(result.release.desktop.windowsSigning, 'unsigned');
    const macFeed = readFileSync(join(result.versionRoot, 'updates/latest-mac.yml'), 'utf8');
    assert.match(macFeed, /https:\/\/download\.example\.com\/clawee\/releases\/v1\.2\.3\/desktop\/macos\/x64\/Clawee-1\.2\.3\.zip/);
    assert.match(macFeed, /sha512:/);
    const sums = readFileSync(join(result.versionRoot, 'SHA256SUMS'), 'utf8');
    assert.match(sums, /release\.json/);
    assert.match(sums, /release-notes\.md/);
    assert.doesNotMatch(sums, /  SHA256SUMS/);
    assert.match(
      readFileSync(join(result.versionRoot, 'release-notes.md'), 'utf8'),
      /Windows x64 安装包当前未进行 Authenticode 签名/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('拒绝未知产物、updater 路径穿越和版本降级', () => {
  assert.throws(() => assertCanPromote(
    { version: '2.0.0', channel: 'stable' },
    { version: '1.9.0', channel: 'stable' }
  ), /downgrade/);
  assert.equal(assertCanPromote(undefined, { version: '2.0.0', channel: 'stable' }), 'new');
  assert.throws(() => assertCanPromote(
    { version: '2.0.0', channel: 'stable', commit: 'a' },
    { version: '2.0.0', channel: 'stable', commit: 'b' }
  ), /different content/);
});

test('版本目录按 SemVer 降序并隔离预发布渠道', () => {
  const release = {
    version: '2.0.0-rc.2', tag: 'v2.0.0-rc.2', channel: 'prerelease',
    publishedAt: '2026-09-10T10:00:00.000Z'
  };
  const catalog = buildVersionsCatalog({
    release,
    releaseUrl: 'https://download.example.com/clawee/releases/v2.0.0-rc.2/release.json',
    current: {
      schemaVersion: 1, product: 'Clawee', channel: 'prerelease',
      generatedAt: '2026-09-01T00:00:00.000Z',
      versions: [{
        version: '2.0.0-rc.1', tag: 'v2.0.0-rc.1',
        publishedAt: '2026-09-01T00:00:00.000Z',
        releaseUrl: 'https://download.example.com/clawee/releases/v2.0.0-rc.1/release.json'
      }]
    }
  });
  assert.deepEqual(catalog.versions.map(item => item.version), ['2.0.0-rc.2', '2.0.0-rc.1']);
  assert.equal(catalog.channel, 'prerelease');
});

function updater(version, name) {
  const values = {
    'Clawee-1.2.3.zip': 'zip-x64',
    'Clawee-1.2.3-arm64.zip': 'zip-arm64',
    'Clawee-Setup-1.2.3.exe': 'exe'
  };
  const content = values[name];
  const sha512 = createHash('sha512').update(content).digest('base64');
  return `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${content.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: 2026-09-10T10:00:00.000Z\n`;
}

function details(directory, name) {
  const content = readFileSync(join(directory, name));
  return {
    name,
    source: name,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex')
  };
}
