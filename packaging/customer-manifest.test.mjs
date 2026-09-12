import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectDeliveries, fileRecord, verifyFiles } from './customer-manifest.mjs';
import { git, readCustomer, readUpstream, root } from './customer-config.mjs';

test('交付文件在分发前重新验证大小和哈希，拒绝篡改与路径穿越', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawee-delivery-test-'));
  try {
    const path = join(root, 'Clawee.dmg');
    writeFileSync(path, 'installer');
    const file = fileRecord(path);
    verifyFiles(root, [file]);
    assert.throws(() => verifyFiles(root, [{ ...file, bytes: 0 }]));
    assert.throws(() => verifyFiles(root, [{ ...file, sha256: '0'.repeat(64) }]));
    assert.throws(() => verifyFiles(root, [{ ...file, name: '../Clawee.dmg' }]));
    assert.throws(() => verifyFiles(root, [{ ...file, name: '..\\Clawee.dmg' }]));
    assert.throws(() => verifyFiles(root, [file, file]));
    assert.throws(() => verifyFiles(root, []));
    writeFileSync(path, 'tampered');
    assert.throws(() => verifyFiles(root, [file]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('只有同一客户和提交的三个完整平台才能汇总交付', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-delivery-collect-'));
  const oldRepository = process.env.GITHUB_REPOSITORY;
  const oldRunId = process.env.GITHUB_RUN_ID;
  process.env.GITHUB_REPOSITORY = 'example/customer-repository';
  process.env.GITHUB_RUN_ID = '123';
  const customer = readCustomer('demo');
  const sha = git(['rev-parse', 'HEAD']);
  const version = JSON.parse(readFileSync(join(root, 'client/apps/desktop/package.json'), 'utf8')).version;
  const deliveryRoot = join(directory, 'demo', version, sha);
  const writeDelivery = (path, delivery) => {
    const manifestPath = join(path, 'customer-delivery.json');
    writeFileSync(manifestPath, JSON.stringify(delivery));
    writeFileSync(join(path, 'SHA256SUMS'), [...delivery.files, fileRecord(manifestPath)].map((file) => `${file.sha256}  ${file.name}\n`).join(''));
  };
  try {
    const deliveries = [];
    for (const [platform, arch] of [['macos', 'arm64'], ['macos', 'x64'], ['windows', 'x64']]) {
      const path = join(deliveryRoot, platform, arch);
      mkdirSync(path, { recursive: true });
      const buildManifest = join(path, 'desktop-build.json');
      const installer = join(path, platform === 'macos' ? 'Clawee.dmg' : 'Clawee.exe');
      writeFileSync(buildManifest, '{}');
      writeFileSync(installer, `${platform}-${arch}`);
      const delivery = {
        customer: 'demo', privateSha: sha, version, upstream: readUpstream(), configSha256: customer.configSha256,
        workflowRun: 'https://github.com/example/customer-repository/actions/runs/123', platform, arch,
        signature: platform === 'macos' ? 'signed_notarized' : 'unsigned', buildManifest: 'desktop-build.json',
        files: [fileRecord(installer), fileRecord(buildManifest)]
      };
      deliveries.push([path, delivery]);
      if (platform === 'windows') assert.throws(() => collectDeliveries('demo', directory));
      writeDelivery(path, delivery);
    }
    const [path, original] = deliveries[0];
    for (const change of [{ customer: 'customer-a' }, { privateSha: '0'.repeat(40) }, { configSha256: '0'.repeat(64) }, { signature: 'unsigned' }]) {
      writeDelivery(path, { ...original, ...change });
      assert.throws(() => collectDeliveries('demo', directory));
    }
    writeDelivery(path, original);
    writeFileSync(join(path, 'SHA256SUMS'), 'tampered');
    assert.throws(() => collectDeliveries('demo', directory));
    writeDelivery(path, original);
    collectDeliveries('demo', directory);
    const result = JSON.parse(readFileSync(join(deliveryRoot, 'customer-delivery.json'), 'utf8'));
    assert.equal(result.status, 'verified');
    assert.equal(result.platforms.length, 3);
    assert.throws(() => collectDeliveries('demo', directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (oldRepository === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = oldRepository;
    if (oldRunId === undefined) delete process.env.GITHUB_RUN_ID; else process.env.GITHUB_RUN_ID = oldRunId;
  }
});
