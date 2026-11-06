import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  parseConfigArgument,
  verifyPackageIntegrity
} from '../../apps/daemon/scripts/start-packaged-server.mjs';
import {
  assertNoSymbolicLinks,
  assertProductionPackageContents,
  inspectManagedFiles,
  pruneDeployment
} from '../../scripts/server-package.mjs';

let tempDir = '';

test('server deployment retains the trusted skill review resource', async () => {
  const packageRoot = createPackageRoot();
  const daemonRoot = join(packageRoot, 'daemon');
  const rulePath = join(daemonRoot, 'resources/skills/skill-review/SKILL.md');
  mkdirSync(join(daemonRoot, 'resources/skills/skill-review'), { recursive: true });
  mkdirSync(join(daemonRoot, 'src'), { recursive: true });
  const rule = readFileSync(new URL('../../apps/daemon/resources/skills/skill-review/SKILL.md', import.meta.url));
  writeFileSync(rulePath, rule);
  writeFileSync(join(daemonRoot, 'package.json'), JSON.stringify({ name: '@clawee/daemon', type: 'module' }));
  pruneDeployment(daemonRoot);
  assert.deepEqual(readFileSync(rulePath), rule);
  assert.equal(existsSync(join(daemonRoot, 'src')), false);
  assert.doesNotThrow(() => assertProductionPackageContents(packageRoot));
  const files = await inspectManagedFiles(packageRoot);
  assert.ok(files.some(file => file.path === 'daemon/resources/skills/skill-review/SKILL.md'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

test('packaged launcher accepts exactly one config argument', () => {
  assert.equal(parseConfigArgument(['--config', './server.toml']), join(process.cwd(), 'server.toml'));
  assert.throws(() => parseConfigArgument([]), /SERVER_CONFIG_INVALID/);
  assert.throws(
    () => parseConfigArgument(['--config=a', '--config=b']),
    /SERVER_CONFIG_INVALID/
  );
  assert.throws(
    () => parseConfigArgument(['--config=a', '--port=1']),
    /SERVER_CONFIG_INVALID/
  );
});

test('package integrity rejects modified managed files', async () => {
  const packageRoot = createPackageRoot();
  const manifest = { files: await inspectManagedFiles(packageRoot) };

  await assert.doesNotReject(() => verifyPackageIntegrity(packageRoot, manifest));
  writeFileSync(join(packageRoot, 'web/index.html'), 'modified');
  await assert.rejects(
    () => verifyPackageIntegrity(packageRoot, manifest),
    /SERVER_PACKAGE_INTEGRITY_FAILED/
  );
});

test('package validation rejects symbolic links', () => {
  const packageRoot = createPackageRoot();
  symlinkSync(
    join(packageRoot, process.platform === 'win32' ? 'web' : 'web/index.html'),
    join(packageRoot, 'web/link.html'),
    process.platform === 'win32' ? 'junction' : 'file'
  );

  assert.throws(
    () => assertNoSymbolicLinks(packageRoot),
    /SERVER_PACKAGE_SYMLINK_FORBIDDEN/
  );
});

test('package validation rejects source and test content', () => {
  const packageRoot = createPackageRoot();
  writeFileSync(join(packageRoot, 'daemon/package.json'), JSON.stringify({
    name: '@clawee/daemon',
    version: '0.1.0',
    type: 'module'
  }));
  mkdirSync(join(packageRoot, 'daemon/node_modules/example/tests'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'daemon/node_modules/example/tests/example.test.js'),
    'test'
  );

  assert.throws(
    () => assertProductionPackageContents(packageRoot),
    /SERVER_PACKAGE_FORBIDDEN_CONTENT/
  );
});

test('package validation rejects development metadata', () => {
  const packageRoot = createPackageRoot();
  writeFileSync(join(packageRoot, 'daemon/package.json'), JSON.stringify({
    name: '@clawee/daemon',
    version: '0.1.0',
    type: 'module',
    scripts: { dev: 'tsx src/main.ts' },
    dependencies: { '@clawee/protocol': 'workspace:*' }
  }));

  assert.throws(
    () => assertProductionPackageContents(packageRoot),
    /SERVER_PACKAGE_DEVELOPMENT_METADATA_FORBIDDEN/
  );
});

test('package validation allows product assets under web examples directories', () => {
  const packageRoot = createPackageRoot();
  writeFileSync(join(packageRoot, 'daemon/package.json'), JSON.stringify({
    name: '@clawee/daemon',
    version: '0.1.0',
    type: 'module'
  }));
  mkdirSync(join(packageRoot, 'web/skill-market/examples'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'web/skill-market/examples/product.png'),
    'product asset'
  );

  assert.doesNotThrow(() => assertProductionPackageContents(packageRoot));
});

test('package validation allows nested runtime doc directories', () => {
  const packageRoot = createPackageRoot();
  writeFileSync(join(packageRoot, 'daemon/package.json'), JSON.stringify({
    name: '@clawee/daemon',
    version: '0.1.0',
    type: 'module'
  }));
  mkdirSync(join(packageRoot, 'daemon/node_modules/yaml/dist/doc'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'daemon/node_modules/yaml/dist/doc/directives.js'),
    'runtime module'
  );

  assert.doesNotThrow(() => assertProductionPackageContents(packageRoot));
});

test('package validation rejects empty non-runtime source directories', () => {
  const packageRoot = createPackageRoot();
  writeFileSync(join(packageRoot, 'daemon/package.json'), JSON.stringify({
    name: '@clawee/daemon',
    version: '0.1.0',
    type: 'module'
  }));
  mkdirSync(join(packageRoot, 'daemon/node_modules/example/src'), { recursive: true });

  assert.throws(
    () => assertProductionPackageContents(packageRoot),
    /SERVER_PACKAGE_FORBIDDEN_CONTENT/
  );
});

function createPackageRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-package-test-'));
  for (const root of ['bin', 'daemon', 'web', 'codex-runtime', 'deployment']) {
    mkdirSync(join(tempDir, root), { recursive: true });
    writeFileSync(join(tempDir, root, `${root}.txt`), root);
  }
  writeFileSync(join(tempDir, 'deployment/server-build-manifest.json'), '{}');
  return tempDir;
}
