import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  coscliSha256,
  coscliVersion,
  bootstrapRelease,
  createCoscliStorage,
  promoteRelease,
  publishImmutableObjects,
  publishPreflight,
  validateStagedRelease,
  verifyPublicImmutableRelease,
  verifyPublicChannel
} from './cos-publish.mjs';

test('固定 COSCLI 版本和官方摘要', () => {
  assert.equal(coscliVersion, 'v1.0.9');
  assert.equal(coscliSha256, 'a07de5ba2800147a700ed29036b0c76a4229088cee68e1682d0eae19b638a915');
});

test('COSCLI 适配器使用加速端点、HEAD 元数据校验并清理 0600 凭据文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-fake-coscli-'));
  const previousRoot = process.env.FAKE_COS_ROOT;
  const previousLog = process.env.FAKE_COS_LOG;
  try {
    const executable = join(root, 'fake-coscli.mjs');
    const objectRoot = join(root, 'objects');
    const logPath = join(root, 'calls.log');
    mkdirSync(objectRoot);
    writeFileSync(executable, fakeCoscliSource());
    chmodSync(executable, 0o700);
    process.env.FAKE_COS_ROOT = objectRoot;
    process.env.FAKE_COS_LOG = logPath;
    const storage = createCoscliStorage({
      bucket: 'clawee-1250000000',
      region: 'ap-guangzhou',
      uploadEndpoint: 'cos.accelerate.myqcloud.com',
      publicBaseUrl: 'https://download.example.com',
      prefix: 'clawee',
      coscliPath: executable,
      secretId: 'test-secret-id',
      secretKey: 'test-secret-key',
      temporaryDirectory: root
    });
    const source = join(root, 'artifact.bin');
    writeFileSync(source, 'content');
    await storage.assertVersioningEnabled();
    await storage.put(
      'clawee/releases/v1.0.0/artifact.bin',
      source,
      { 'Cache-Control': 'immutable', 'Content-Type': 'application/octet-stream' },
      { forbidOverwrite: true }
    );
    assert.deepEqual(
      await storage.stat('clawee/releases/v1.0.0/artifact.bin'),
      {
        bytes: 7,
        sha256: createHash('sha256').update('content').digest('hex')
      }
    );
    assert.equal(
      (await storage.get('clawee/releases/v1.0.0/artifact.bin')).toString(),
      'content'
    );
    assert.equal(await storage.get('clawee/catalog/stable/latest.json'), null);
    const calls = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
    const versioning = calls.find(args => args[0] === 'bucket-versioning');
    assert.equal(versioning.includes('--disable-log'), false);
    assert.ok(versioning.includes('--log-path'));
    const upload = calls.find(args => args[0] === 'cp' && !args[1].startsWith('cos://'));
    assert.ok(upload.includes('--disable-checksum=false'));
    assert.ok(upload.includes('--forbid-overwrite=true'));
    assert.match(upload[upload.indexOf('--meta') + 1], /x-cos-meta-sha256:[0-9a-f]{64}/);
    const configPath = upload[upload.indexOf('-c') + 1];
    assert.match(readFileSync(configPath, 'utf8'), /endpoint: "cos\.accelerate\.myqcloud\.com"/);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    storage.close();
    assert.equal(existsSync(configPath), false);
  } finally {
    if (previousRoot === undefined) delete process.env.FAKE_COS_ROOT;
    else process.env.FAKE_COS_ROOT = previousRoot;
    if (previousLog === undefined) delete process.env.FAKE_COS_LOG;
    else process.env.FAKE_COS_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test('不可变对象先校验后上传且相同内容可幂等重跑', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-cos-immutable-'));
  try {
    mkdirSync(join(root, 'updates'));
    writeFileSync(join(root, 'artifact.bin'), 'artifact');
    writeFileSync(join(root, 'updates', 'latest.yml'), 'feed');
    const storage = new MetadataStorage();
    await publishImmutableObjects({ storage, versionRoot: root, prefix: 'clawee', tag: 'v1.0.0' });
    const firstPutCount = storage.operations.filter(item => item.startsWith('put:')).length;
    await publishImmutableObjects({ storage, versionRoot: root, prefix: 'clawee', tag: 'v1.0.0' });
    assert.equal(storage.operations.filter(item => item.startsWith('put:')).length, firstPutCount);
    assert.equal(storage.operations.some(item => item.startsWith('get:')), false);
    storage.values.set('clawee/releases/v1.0.0/artifact.bin', Buffer.from('different'));
    await assert.rejects(
      publishImmutableObjects({ storage, versionRoot: root, prefix: 'clawee', tag: 'v1.0.0' }),
      /Refusing to overwrite/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('渠道晋级最后写 latest.json 并拒绝降级', async () => {
  const fixture = releaseFixture('2.0.0');
  try {
    const storage = new MemoryStorage();
    const result = await promoteRelease({ ...fixture, storage });
    assert.equal(result.promoted, true);
    const writes = storage.operations.filter(item => item.startsWith('put:'));
    assert.match(writes.at(-1), /catalog\/stable\/latest\.json$/);
    const older = releaseFixture('1.9.0');
    try {
      await assert.rejects(promoteRelease({ ...older, storage }), /downgrade/);
    } finally {
      older.cleanup();
    }
  } finally {
    fixture.cleanup();
  }
});

test('同版本重跑会修复损坏的渠道文件', async () => {
  const fixture = releaseFixture('2.0.0');
  try {
    const storage = new MemoryStorage();
    await promoteRelease({ ...fixture, storage });
    const feedKey = 'clawee/updates/stable/latest.yml';
    storage.values.set(feedKey, Buffer.from('damaged'));
    const result = await promoteRelease({ ...fixture, storage });
    assert.equal(result.promoted, true);
    assert.equal(storage.values.get(feedKey).toString(), 'version: 2.0.0\n');
  } finally {
    fixture.cleanup();
  }
});

test('只在渠道为空时执行首次 bootstrap', async () => {
  const fixture = releaseFixture('2.0.0');
  try {
    const storage = new MemoryStorage();
    assert.equal((await bootstrapRelease({ ...fixture, storage })).bootstrapped, true);
    const writes = storage.operations.filter(item => item.startsWith('put:')).length;
    assert.equal((await bootstrapRelease({ ...fixture, storage })).bootstrapped, false);
    assert.equal(storage.operations.filter(item => item.startsWith('put:')).length, writes);
  } finally {
    fixture.cleanup();
  }
});

test('晋级前校验发布身份和精确 updater 文件集', () => {
  const fixture = releaseFixture('2.0.0');
  try {
    for (const name of ['latest-mac.yml', 'latest-arm64-mac.yml']) {
      writeFileSync(join(fixture.versionRoot, 'updates', name), `version: ${fixture.release.version}\n`);
    }
    const input = {
      ...fixture,
      tag: fixture.release.tag,
      version: fixture.release.version,
      commit: fixture.release.commit
    };
    validateStagedRelease(input);
    assert.throws(
      () => validateStagedRelease({ ...input, commit: 'b'.repeat(40) }),
      /identity/
    );
    writeFileSync(join(fixture.versionRoot, 'updates', 'latest-extra.yml'), 'unexpected');
    assert.throws(() => validateStagedRelease(input), /Unexpected staged updater files/);
  } finally {
    fixture.cleanup();
  }
});

test('渠道写入失败时恢复已经覆盖的对象', async () => {
  const fixture = releaseFixture('2.0.0');
  try {
    const storage = new MemoryStorage();
    const feedKey = 'clawee/updates/stable/latest.yml';
    const versionsKey = 'clawee/catalog/stable/versions.json';
    storage.values.set(feedKey, Buffer.from('old-feed'));
    storage.values.set(versionsKey, Buffer.from(JSON.stringify({
      schemaVersion: 1, product: 'Clawee', channel: 'stable', generatedAt: '2026-01-01T00:00:00.000Z', versions: []
    })));
    storage.failOnce = versionsKey;
    await assert.rejects(promoteRelease({ ...fixture, storage }), /injected failure/);
    assert.equal(storage.values.get(feedKey).toString(), 'old-feed');
    assert.match(storage.values.get(versionsKey).toString(), /"versions":\[\]/);
  } finally {
    fixture.cleanup();
  }
});

test('公开渠道校验失败时同样恢复已覆盖对象', async () => {
  const fixture = releaseFixture('2.0.0');
  try {
    const storage = new MemoryStorage();
    const feedKey = 'clawee/updates/stable/latest.yml';
    storage.values.set(feedKey, Buffer.from('old-feed'));
    storage.values.set('clawee/catalog/stable/versions.json', Buffer.from(JSON.stringify({
      schemaVersion: 1, product: 'Clawee', channel: 'stable', generatedAt: '2026-01-01T00:00:00.000Z', versions: []
    })));
    storage.values.set('clawee/catalog/stable/latest.json', Buffer.from(JSON.stringify({
      ...fixture.release, version: '1.0.0', tag: 'v1.0.0'
    })));
    let failed = false;
    await assert.rejects(promoteRelease({
      ...fixture,
      storage,
      async verify(change) {
        if (!failed && change.key.endsWith('versions.json')) {
          failed = true;
          throw new Error('public verification failed');
        }
      }
    }), /public verification failed/);
    assert.equal(storage.values.get(feedKey).toString(), 'old-feed');
  } finally {
    fixture.cleanup();
  }
});

test('单个恢复对象失败时仍继续恢复其他渠道对象', async () => {
  const fixture = releaseFixture('2.0.0');
  try {
    const storage = new MemoryStorage();
    const feedKey = 'clawee/updates/stable/latest.yml';
    const versionsKey = 'clawee/catalog/stable/versions.json';
    const latestKey = 'clawee/catalog/stable/latest.json';
    storage.values.set(feedKey, Buffer.from('old-feed'));
    storage.values.set(versionsKey, Buffer.from(JSON.stringify({
      schemaVersion: 1, product: 'Clawee', channel: 'stable',
      generatedAt: '2026-01-01T00:00:00.000Z', versions: []
    })));
    storage.values.set(latestKey, Buffer.from(JSON.stringify({
      ...fixture.release, version: '1.0.0', tag: 'v1.0.0'
    })));
    const put = storage.put.bind(storage);
    let failVersionsRecovery = false;
    storage.put = async (key, path) => {
      if (failVersionsRecovery && key === versionsKey) throw new Error('recovery failed');
      return put(key, path);
    };
    let failed = false;
    await assert.rejects(promoteRelease({
      ...fixture,
      storage,
      async verify(change) {
        if (!failed && change.key === latestKey) {
          failed = true;
          failVersionsRecovery = true;
          throw new Error('public verification failed');
        }
      }
    }), AggregateError);
    assert.equal(storage.values.get(feedKey).toString(), 'old-feed');
    assert.match(storage.values.get(latestKey).toString(), /"version":"1\.0\.0"/);
  } finally {
    fixture.cleanup();
  }
});

test('Preflight 只接受完整产物集并写入 SHA 与 Run ID 目录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-cos-preflight-test-'));
  const sha = 'c'.repeat(40);
  try {
    createPreflightArtifacts(root, sha);
    const storage = new MemoryStorage();
    const result = await publishPreflight({
      storage, prefix: 'clawee', artifactDirectory: root,
      targetSha: sha, runId: '123', createdAt: '2026-09-10T10:00:00.000Z'
    });
    assert.equal(result.root, `clawee/preflight/${sha}/123`);
    assert.ok(storage.values.has(`${result.root}/preflight-manifest.json`));
    assert.deepEqual(
      storage.operations.filter(item => item.startsWith('put:')),
      [`put:${result.root}/preflight-manifest.json`]
    );
    const manifest = JSON.parse(storage.values.get(`${result.root}/preflight-manifest.json`));
    assert.equal(manifest.artifacts.length, 16);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Preflight 拒绝缺少 updater ZIP 或 blockmap 的产物集', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-cos-preflight-incomplete-'));
  const sha = 'd'.repeat(40);
  try {
    createPreflightArtifacts(root, sha);
    rmSync(join(root, 'Clawee-1.0.0-mac.zip'));
    await assert.rejects(publishPreflight({
      storage: new MemoryStorage(), prefix: 'clawee', artifactDirectory: root,
      targetSha: sha, runId: '124'
    }), /Clawee-1\.0\.0(?:-mac)?\.zip/);

    writeFileSync(join(root, 'Clawee-1.0.0-mac.zip'), 'zip');
    rmSync(join(root, 'Clawee-Setup-1.0.0.exe.blockmap'));
    await assert.rejects(publishPreflight({
      storage: new MemoryStorage(), prefix: 'clawee', artifactDirectory: root,
      targetSha: sha, runId: '125'
    }), /Clawee-Setup-1\.0\.0\.exe\.blockmap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Preflight 拒绝子目录中的合法文件名', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-cos-preflight-nested-'));
  const sha = 'e'.repeat(40);
  try {
    createPreflightArtifacts(root, sha);
    const nested = join(root, 'nested');
    mkdirSync(nested);
    renameSync(join(root, 'latest.yml'), join(nested, 'latest.yml'));
    await assert.rejects(publishPreflight({
      storage: new MemoryStorage(), prefix: 'clawee', artifactDirectory: root,
      targetSha: sha, runId: '126'
    }), /Unexpected nested preflight artifact: nested[/\\\\]latest\.yml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('公网校验只通过 HEAD 和 Range 检查 updater 包', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-cos-public-immutable-'));
  try {
    const fixture = publicImmutableFixture(root);
    await verifyPublicImmutableRelease({ ...fixture, fetchImpl: fixture.fetchImpl });
    const zipRequests = fixture.requests.filter(item => item.url === fixture.zipUrl);
    assert.deepEqual(zipRequests.map(item => item.method), ['HEAD', 'GET']);
    assert.equal(zipRequests[1].range, 'bytes=0-0');
    fixture.objects.set(fixture.zipUrl, Buffer.from('bad'));
    await assert.rejects(
      verifyPublicImmutableRelease({ ...fixture, fetchImpl: fixture.fetchImpl }),
      /Content-Length mismatch/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('通过公开域名复核渠道目录和 updater 缓存策略', async () => {
  const fixture = releaseFixture('2.0.0');
  try {
    const storage = new MemoryStorage();
    await promoteRelease({ ...fixture, storage });
    const fetchImpl = async url => {
      const key = new URL(url).pathname.replace(/^\//, '');
      const body = storage.values.get(key);
      return new Response(body ?? 'missing', {
        status: body ? 200 : 404,
        headers: {
          'Cache-Control': 'no-cache,max-age=0,must-revalidate',
          'Content-Type': key.endsWith('.json')
            ? 'application/json; charset=utf-8'
            : 'application/yaml; charset=utf-8'
        }
      });
    };
    await verifyPublicChannel({ ...fixture, fetchImpl });
  } finally {
    fixture.cleanup();
  }
});

class MemoryStorage {
  values = new Map();
  operations = [];
  failOnce;

  async get(key) {
    this.operations.push(`get:${key}`);
    return this.values.get(key) ?? null;
  }

  async put(key, path) {
    this.operations.push(`put:${key}`);
    if (this.failOnce === key) {
      this.failOnce = undefined;
      throw new Error('injected failure');
    }
    this.values.set(key, readFileSync(path));
  }
}

class MetadataStorage extends MemoryStorage {
  async stat(key) {
    this.operations.push(`stat:${key}`);
    const value = this.values.get(key);
    if (value === undefined) return null;
    return {
      bytes: value.length,
      sha256: createHash('sha256').update(value).digest('hex')
    };
  }

  async get(key) {
    this.operations.push(`get:${key}`);
    throw new Error('metadata-backed storage should not download objects');
  }
}

function releaseFixture(version) {
  const root = mkdtempSync(join(tmpdir(), 'clawee-cos-promote-test-'));
  mkdirSync(join(root, 'updates'));
  writeFileSync(join(root, 'updates', 'latest.yml'), `version: ${version}\n`);
  return {
    config: {
      bucket: 'clawee-1250000000', region: 'ap-guangzhou',
      publicBaseUrl: 'https://download.example.com', prefix: 'clawee'
    },
    versionRoot: root,
    release: {
      schemaVersion: 1, product: 'Clawee', version, tag: `v${version}`,
      channel: 'stable', commit: 'a'.repeat(40),
      publishedAt: '2026-09-10T10:00:00.000Z', artifacts: []
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); }
  };
}

function createServerArchive(root, arch, commit) {
  const build = join(root, `server-${arch}`);
  mkdirSync(build);
  writeFileSync(join(build, 'release-manifest.json'), JSON.stringify({ commit }));
  const output = join(root, `clawee-server-preflight-linux-${arch}.tar.gz`);
  const result = spawnSync('tar', ['-czf', output, '-C', build, '.'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  rmSync(build, { recursive: true, force: true });
}

function createPreflightArtifacts(root, sha) {
  for (const name of [
    'Clawee-1.0.0.dmg', 'Clawee-1.0.0-mac.zip', 'Clawee-1.0.0-mac.zip.blockmap',
    'Clawee-1.0.0-arm64.dmg', 'Clawee-1.0.0-arm64-mac.zip',
    'Clawee-1.0.0-arm64-mac.zip.blockmap', 'Clawee-Setup-1.0.0.exe',
    'Clawee-Setup-1.0.0.exe.blockmap', 'latest.yml', 'latest-mac.yml',
    'latest-arm64-mac.yml'
  ]) writeFileSync(join(root, name), name);
  for (const name of [
    'clawee-desktop-build-manifest-mac-x64.json',
    'clawee-desktop-build-manifest-mac-arm64.json',
    'clawee-desktop-build-manifest-win-x64.json'
  ]) writeFileSync(join(root, name), JSON.stringify({ commit: sha, officialRelease: false }));
  for (const arch of ['amd64', 'arm64']) createServerArchive(root, arch, sha);
}

function publicImmutableFixture(root) {
  const config = {
    bucket: 'clawee-1250000000', region: 'ap-guangzhou',
    publicBaseUrl: 'https://download.example.com', prefix: 'clawee'
  };
  const tag = 'v2.0.0';
  const versionRoot = join(root, 'releases', tag);
  const updates = join(versionRoot, 'updates');
  mkdirSync(updates, { recursive: true });
  const zipUrl = `${config.publicBaseUrl}/${config.prefix}/releases/${tag}/desktop/macos/x64/Clawee-2.0.0.zip`;
  const blockmapUrl = `${zipUrl}.blockmap`;
  const zip = Buffer.from('updater-zip');
  const blockmap = Buffer.from('blockmap');
  const release = {
    schemaVersion: 1, product: 'Clawee', version: '2.0.0', tag,
    channel: 'stable', commit: 'a'.repeat(40), publishedAt: '2026-09-10T10:00:00.000Z',
    artifacts: [
      { format: 'zip', name: 'Clawee-2.0.0.zip', bytes: zip.length, downloadUrl: zipUrl },
      { format: 'blockmap', name: 'Clawee-2.0.0.zip.blockmap', bytes: blockmap.length, downloadUrl: blockmapUrl }
    ]
  };
  writeFileSync(join(versionRoot, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  writeFileSync(join(updates, 'latest-mac.yml'), [
    'version: 2.0.0',
    'files:',
    `  - url: ${zipUrl}`,
    `    sha512: ${createHash('sha512').update(zip).digest('base64')}`,
    `    size: ${zip.length}`,
    ''
  ].join('\n'));
  const objects = new Map([
    [`${config.publicBaseUrl}/${config.prefix}/releases/${tag}/release.json`, readFileSync(join(versionRoot, 'release.json'))],
    [`${config.publicBaseUrl}/${config.prefix}/releases/${tag}/updates/latest-mac.yml`, readFileSync(join(updates, 'latest-mac.yml'))],
    [zipUrl, zip],
    [blockmapUrl, blockmap]
  ]);
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const cleanUrl = new URL(url);
    cleanUrl.search = '';
    const key = cleanUrl.toString();
    requests.push({
      url: key,
      method: options.method ?? 'GET',
      range: options.headers?.Range
    });
    const content = objects.get(key);
    const type = key.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : key.endsWith('.yml')
        ? 'application/yaml; charset=utf-8'
        : key.endsWith('.zip') ? 'application/zip' : 'application/octet-stream';
    const headers = {
      'Cache-Control': 'public, immutable, max-age=31536000',
      'Content-Type': type,
      'Content-Length': String(content?.length ?? 0)
    };
    if (content === undefined) return new Response('missing', { status: 404, headers });
    if (options.method === 'HEAD') return new Response(null, { status: 200, headers });
    if (options.headers?.Range) return new Response(content.subarray(0, 1), { status: 206, headers });
    return new Response(content, { status: 200, headers });
  };
  return { config, release, versionRoot, objects, zipUrl, requests, fetchImpl };
}

function fakeCoscliSource() {
  return `#!/usr/bin/env node
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_COS_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'bucket-versioning') {
  if (!args.includes('--disable-log')) console.log('bucket versioning status is Enabled');
  process.exit(0);
}
const objectPath = value => join(process.env.FAKE_COS_ROOT, value.replace(/^cos:\\/\\/[^/]+\\//, ''));
if (args[0] === 'stat') {
  const source = objectPath(args[1]);
  if (!existsSync(source)) {
    const logIndex = args.indexOf('--log-path');
    writeFileSync(args[logIndex + 1], 'NoSuchKey: status code 404');
    process.exit(1);
  }
  console.log('Content-Length: ' + statSync(source).size);
  const metadataPath = source + '.metadata';
  if (existsSync(metadataPath)) {
    const match = /x-cos-meta-sha256:([0-9a-f]{64})/i.exec(readFileSync(metadataPath, 'utf8'));
    if (match) console.log('x-cos-meta-sha256: ' + match[1]);
  }
  process.exit(0);
}
if (args[0] !== 'cp') process.exit(2);
if (args[1].startsWith('cos://')) {
  const source = objectPath(args[1]);
  if (!existsSync(source)) {
    process.exit(1);
  }
  mkdirSync(dirname(args[2]), { recursive: true });
  copyFileSync(source, args[2]);
} else {
  const destination = objectPath(args[2]);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(args[1], destination);
  const metadataIndex = args.indexOf('--meta');
  if (metadataIndex !== -1) writeFileSync(destination + '.metadata', args[metadataIndex + 1]);
}
`;
}
