import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { create as createTar } from 'tar';
import {
  readCodexRuntimeManifest,
  resolveCodexRuntimeTarget
} from './codex-runtime/manifest.mjs';
import { prepareCodexRuntime } from '../apps/desktop/scripts/codex-runtime-assets.mjs';
import { inspectDirectory } from '../apps/desktop/scripts/directory-integrity.mjs';
import {
  removeWorkspaceSelfReference
} from '../apps/desktop/scripts/daemon-deployment-contract.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = join(projectRoot, 'release/server');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const MANAGED_ROOTS = ['bin', 'daemon', 'web', 'codex-runtime', 'deployment'];

export async function packageServer() {
  const runtimeManifest = readCodexRuntimeManifest(join(
    projectRoot,
    'config/codex-runtime.json'
  ));
  const runtimeTarget = resolveCodexRuntimeTarget(runtimeManifest, {
    platform: process.platform,
    arch: process.arch
  });
  if (runtimeTarget.formalRelease !== true) {
    throw new Error('SERVER_RUNTIME_NOT_FORMAL');
  }
  const productPackage = readJson(join(projectRoot, 'apps/desktop/package.json'));
  const commit = gitOutput(['rev-parse', 'HEAD']);
  const dirty = gitOutput(['status', '--porcelain']).length > 0;
  const suffix = dirty ? '-dirty' : '';
  const packageName = [
    `clawee-server-${productPackage.version}`,
    process.platform,
    `${process.arch}${suffix}`
  ].join('-');

  mkdirSync(releaseRoot, { recursive: true });
  const workRoot = mkdtempSync(join(tmpdir(), 'clawee-server-package-'));
  const packageRoot = join(workRoot, packageName);
  const deployedDaemon = join(workRoot, 'deployed-daemon');
  const archiveExtension = process.platform === 'win32' ? '.zip' : '.tar.gz';
  const archivePath = join(releaseRoot, `${packageName}${archiveExtension}`);
  const externalManifestPath = join(releaseRoot, `${packageName}.manifest.json`);

  try {
    await runStage('校验冻结锁文件', pnpmCommand, [
      'install',
      '--frozen-lockfile',
      '--offline',
      '--lockfile-only',
      '--ignore-scripts'
    ], 60_000);
    await runStage('构建 Daemon', pnpmCommand, [
      '--filter', '@clawee/daemon', 'build'
    ], 5 * 60_000);
    await runStage('构建 Web', pnpmCommand, [
      '--filter', '@clawee/web', 'build'
    ], 5 * 60_000);
    await runStage('部署 Daemon 生产依赖', pnpmCommand, [
      '--frozen-lockfile',
      '--offline',
      '--config.ignore-scripts=true',
      '--config.public-hoist-pattern=*',
      '--filter', '@clawee/daemon',
      'deploy', '--prod', deployedDaemon
    ], 10 * 60_000);
    removeWorkspaceSelfReference(deployedDaemon, '@clawee/daemon');
    rmSync(join(
      deployedDaemon,
      'node_modules/.pnpm/node_modules/@clawee/daemon'
    ), { force: true });
    await rebuildNativeSqlite(deployedDaemon);
    pruneDeployment(deployedDaemon);
    sanitizeDaemonPackage(deployedDaemon);

    mkdirSync(packageRoot, { recursive: true });
    materializeDirectory(deployedDaemon, join(packageRoot, 'daemon'), {
      skipPnpmStore: true
    });
    assertNoSymbolicLinks(join(packageRoot, 'daemon'));
    cpSync(join(projectRoot, 'apps/web/dist'), join(packageRoot, 'web'), {
      recursive: true
    });
    cpSync(
      join(projectRoot, 'apps/daemon/scripts/start-packaged-server.mjs'),
      join(packageRoot, 'bin/clawee-server.mjs')
    );
    mkdirSync(join(packageRoot, 'deployment'), { recursive: true });
    cpSync(
      join(projectRoot, 'config/codex-runtime.json'),
      join(packageRoot, 'deployment/codex-runtime.json')
    );
    await prepareCodexRuntime({
      manifest: runtimeManifest,
      platform: process.platform,
      arch: process.arch,
      stagingDirectory: join(packageRoot, 'codex-runtime'),
      cacheDirectory: join(projectRoot, 'apps/desktop/.cache/codex-runtime')
    });
    writeExampleConfiguration(packageRoot);
    assertProductionPackageContents(packageRoot);

    const [webBuild, daemonBuild, runtimeBuild] = await Promise.all([
      inspectDirectory(join(packageRoot, 'web')),
      inspectDirectory(join(packageRoot, 'daemon')),
      inspectDirectory(join(packageRoot, 'codex-runtime'))
    ]);
    const manifest = {
      schemaVersion: 1,
      product: 'clawee-server',
      version: productPackage.version,
      commit,
      dirty,
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: Number(process.versions.node.split('.')[0]),
      webBuildHash: webBuild.hash,
      daemonBuildHash: daemonBuild.hash,
      codexRuntimeId: runtimeManifest.runtimeId,
      codexRuntimeVersion: runtimeManifest.codexVersion,
      codexRuntimeHash: runtimeBuild.hash,
      files: await inspectManagedFiles(packageRoot)
    };
    writeFileSync(
      join(packageRoot, 'deployment/server-build-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    await smokeTestPackage(packageRoot);
    rmSync(archivePath, { force: true });
    rmSync(externalManifestPath, { force: true });
    if (process.platform === 'win32') {
      createZipArchive(workRoot, packageName, archivePath);
    } else {
      await createTar({ gzip: true, cwd: workRoot, file: archivePath }, [packageName]);
    }
    const externalManifest = {
      schemaVersion: 1,
      product: 'clawee-server',
      version: productPackage.version,
      commit,
      dirty,
      platform: process.platform,
      arch: process.arch,
      archive: basename(archivePath),
      size: statSync(archivePath).size,
      sha256: hashBuffer(readFileSync(archivePath)),
      generatedAt: new Date().toISOString()
    };
    writeFileSync(externalManifestPath, `${JSON.stringify(externalManifest, null, 2)}\n`);
    console.log(JSON.stringify({ archivePath, externalManifestPath }, null, 2));
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

export async function inspectManagedFiles(packageRoot) {
  const files = [];
  for (const root of MANAGED_ROOTS) {
    files.push(...listFiles(packageRoot, join(packageRoot, root)));
  }
  const withoutManifest = files
    .filter(path => path !== 'deployment/server-build-manifest.json')
    .sort();
  return Promise.all(withoutManifest.map(async path => ({
    path,
    sha256: hashBuffer(readFileSync(join(packageRoot, path))),
    mode: lstatSync(join(packageRoot, path)).mode & 0o777
  })));
}

export function assertNoSymbolicLinks(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`SERVER_PACKAGE_SYMLINK_FORBIDDEN: ${path}`);
    }
    if (entry.isDirectory()) assertNoSymbolicLinks(path);
  }
}

async function rebuildNativeSqlite(deployedDaemon) {
  const sourceRoot = realpathSync(join(
    projectRoot,
    'apps/daemon/node_modules/better-sqlite3'
  ));
  const targetRoot = realpathSync(join(
    deployedDaemon,
    'node_modules/better-sqlite3'
  ));
  const nodeGyp = createRequire(join(sourceRoot, 'package.json'))
    .resolve('node-gyp/bin/node-gyp.js');
  const env = { ...process.env };
  delete env.npm_config_runtime;
  delete env.npm_config_target;
  delete env.npm_config_recursive;
  await runStage('重建 Node.js 原生 SQLite', process.execPath, [
    nodeGyp,
    'rebuild',
    '--release'
  ], 10 * 60_000, {
    ...env,
    npm_config_arch: process.arch,
    npm_config_build_from_source: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false'
  }, targetRoot);

  const nativeBinaryPath = join(targetRoot, 'build/Release/better_sqlite3.node');
  const nativeBinary = readFileSync(nativeBinaryPath);
  const nativeBinaryMode = lstatSync(nativeBinaryPath).mode & 0o777;
  rmSync(join(targetRoot, 'build'), { recursive: true, force: true });
  mkdirSync(dirname(nativeBinaryPath), { recursive: true });
  writeFileSync(nativeBinaryPath, nativeBinary, { mode: nativeBinaryMode });

  const require = createRequire(join(deployedDaemon, 'package.json'));
  const Database = require('better-sqlite3');
  const database = new Database(':memory:');
  database.close();
}

function pruneDeployment(root) {
  const allowedRoot = new Set(['dist', 'node_modules', 'package.json']);
  for (const entry of readdirSync(root)) {
    if (!allowedRoot.has(entry)) rmSync(join(root, entry), { recursive: true, force: true });
  }
  pruneTree(root);
}

function pruneTree(root) {
  const removableDirectories = new Set([
    '.bin',
    '.github',
    '__tests__',
    'benchmark',
    'benchmarks',
    'test',
    'tests'
  ]);
  const removablePackageDirectories = new Set(['doc', 'docs', 'example', 'examples']);
  const isPackageRoot = existsSync(join(root, 'package.json'));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (
      removableDirectories.has(entry.name)
      || (isPackageRoot && removablePackageDirectories.has(entry.name))
    ) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (entry.name === 'src' && !packageRequiresSourceDirectory(root)) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {
      pruneTree(path);
      if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
      continue;
    }
    const lowerName = entry.name.toLowerCase();
    if (
      entry.name === '.modules.yaml'
      || entry.name.endsWith('.map')
      || entry.name.endsWith('.d.ts')
      || entry.name.endsWith('.d.cts')
      || entry.name.endsWith('.d.mts')
      || entry.name.endsWith('.ts')
      || entry.name.endsWith('.tsx')
      || entry.name.endsWith('.c')
      || entry.name.endsWith('.cc')
      || entry.name.endsWith('.cpp')
      || entry.name.endsWith('.h')
      || entry.name.endsWith('.hh')
      || entry.name.endsWith('.hpp')
      || /^(?:tests?|specs?)\.(?:c?js|mjs|sh)$/.test(lowerName)
      || /\.(?:test|spec)\.(?:c?js|mjs)$/.test(lowerName)
    ) {
      rmSync(path, { force: true });
    }
  }
}

function packageRequiresSourceDirectory(packageRoot) {
  const packagePath = join(packageRoot, 'package.json');
  if (!existsSync(packagePath)) return false;
  try {
    const metadata = readJson(packagePath);
    return referencesSourceDirectory(metadata.main)
      || referencesSourceDirectory(metadata.exports)
      || referencesSourceDirectory(metadata.imports);
  } catch {
    return false;
  }
}

function referencesSourceDirectory(value) {
  if (typeof value === 'string') return /^(?:\.\/)?src\//.test(value);
  if (Array.isArray(value)) return value.some(referencesSourceDirectory);
  return value !== null
    && typeof value === 'object'
    && Object.values(value).some(referencesSourceDirectory);
}

function sanitizeDaemonPackage(root) {
  const metadata = readJson(join(root, 'package.json'));
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: metadata.name,
    version: metadata.version,
    private: true,
    type: 'module',
    main: './dist/main.js'
  }, null, 2)}\n`);
}

export function assertProductionPackageContents(packageRoot) {
  const forbiddenDaemonPath = /(^|\/)(?:\.pnpm|\.github|__tests__|benchmarks?|tests?)(\/|$)/;
  const forbiddenDaemonPackagePath = /(?:^daemon|\/node_modules\/(?:@[^/]+\/)?[^/]+)\/(?:docs?|examples?)(\/|$)/;
  const forbiddenFile = /(?:\.d\.(?:ts|cts|mts)|\.map|\.(?:ts|tsx|c|cc|cpp|h|hh|hpp|o)|\.(?:test|spec)\.(?:c?js|mjs)|\/(?:tests?|specs?)\.(?:c?js|mjs|sh))$/i;
  const allowedRuntimeSources = [
    'daemon/node_modules/debug/src/',
    'daemon/node_modules/real-require/src/'
  ];
  for (const path of MANAGED_ROOTS.flatMap(root => (
    listPaths(packageRoot, join(packageRoot, root))
  ))) {
    if (
      (path.startsWith('daemon/') && forbiddenDaemonPath.test(path))
      || (path.startsWith('daemon/') && forbiddenDaemonPackagePath.test(path))
      || forbiddenFile.test(path)
      || (
        path.includes('/src/')
        && !allowedRuntimeSources.some(prefix => path.startsWith(prefix))
      )
    ) {
      throw new Error(`SERVER_PACKAGE_FORBIDDEN_CONTENT: ${path}`);
    }
  }
  const daemonMetadata = readJson(join(packageRoot, 'daemon/package.json'));
  const serializedMetadata = JSON.stringify(daemonMetadata);
  if (
    serializedMetadata.includes('workspace:')
    || Object.hasOwn(daemonMetadata, 'devDependencies')
    || Object.hasOwn(daemonMetadata, 'scripts')
  ) {
    throw new Error('SERVER_PACKAGE_DEVELOPMENT_METADATA_FORBIDDEN');
  }
}

function materializeDirectory(source, destination, options = {}) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (options.skipPnpmStore === true && entry.name === '.pnpm') continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      const realPath = realpathSync(sourcePath);
      const info = statSync(realPath);
      if (info.isDirectory()) materializeDirectory(realPath, destinationPath, options);
      else cpSync(realPath, destinationPath);
    } else if (entry.isDirectory()) {
      materializeDirectory(sourcePath, destinationPath, options);
    } else if (entry.isFile()) {
      cpSync(sourcePath, destinationPath, { preserveTimestamps: true });
    }
  }
}

function writeExampleConfiguration(packageRoot) {
  const configDir = join(packageRoot, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'server.example.toml'), [
    '[server]',
    'host = "127.0.0.1"',
    'port = 19860',
    'data_dir = "../data"',
    'default_project_root = "../data/projects"',
    '',
    '# Token 来源二选一。直接配置 token 时，不访问 token_file。',
    '# token = "替换为实际随机Token"',
    'token_file = "../data/server-token"',
    '',
    '[enterprise]',
    'config_file = "./enterprise.toml"',
    ''
  ].join('\n'));
  writeFileSync(join(configDir, 'enterprise.example.toml'), [
    'gateway = "http://127.0.0.1:1904"',
    ''
  ].join('\n'));
}

async function smokeTestPackage(packageRoot) {
  const smokeRoot = mkdtempSync(join(tmpdir(), 'Clawee Server 验收-'));
  const smokePackage = join(smokeRoot, basename(packageRoot));
  try {
    cpSync(packageRoot, smokePackage, { recursive: true });
    const port = await reservePort();
    cpSync(
      join(smokePackage, 'config/enterprise.example.toml'),
      join(smokePackage, 'config/enterprise.toml')
    );
    const token = randomBytes(32).toString('base64url');
    writeFileSync(join(smokePackage, 'config/server.toml'), [
      '[server]',
      'host = "127.0.0.1"',
      `port = ${port}`,
      'data_dir = "../data"',
      'default_project_root = "../data/projects"',
      `token = "${token}"`,
      '',
      '[enterprise]',
      'config_file = "./enterprise.toml"',
      ''
    ].join('\n'), { mode: 0o600 });
    const readinessFailurePreload = join(smokeRoot, 'fail-readiness.mjs');
    writeFileSync(readinessFailurePreload, [
      'const originalFetch = globalThis.fetch;',
      'globalThis.fetch = (input, init) => {',
      '  const url = input instanceof URL',
      '    ? input',
      "    : new URL(typeof input === 'string' ? input : input.url);",
      "  if (url.pathname === '/projects') {",
      '    return Promise.resolve(new Response(null, { status: 401 }));',
      '  }',
      '  return originalFetch(input, init);',
      '};',
      ''
    ].join('\n'));
    expectReadinessFailure(smokePackage, token, readinessFailurePreload);
    await waitForReadyAndShutdown(smokePackage, token);
    await waitForReadyAndShutdown(smokePackage, token);
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

function expectReadinessFailure(packageRoot, forbiddenOutput, preloadPath) {
  const result = spawnSync(process.execPath, [
    join(packageRoot, 'bin/clawee-server.mjs'),
    '--config',
    join(packageRoot, 'config/server.toml')
  ], {
    cwd: tmpdir(),
    env: {
      ...cleanServerEnvironment(process.env),
      NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`
    },
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error !== undefined) throw result.error;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (
    result.status !== 1
    || output.includes('SERVER_READY')
    || !output.includes('SERVER_RUNTIME_API_CHECK_FAILED')
  ) {
    throw new Error(`SERVER_PACKAGE_READINESS_FAILURE_NOT_DETECTED: ${output}`);
  }
  if (output.includes(forbiddenOutput)) {
    throw new Error('SERVER_PACKAGE_SMOKE_SECRET_LEAKED');
  }
}

function waitForReadyAndShutdown(packageRoot, forbiddenOutput) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      join(packageRoot, 'bin/clawee-server.mjs'),
      '--config',
      join(packageRoot, 'config/server.toml')
    ], {
      cwd: tmpdir(),
      env: cleanServerEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let ready = false;
    let settled = false;
    const timer = setTimeout(() => fail(new Error(
      `SERVER_PACKAGE_SMOKE_TIMEOUT: ${stderr || stdout}`
    )), 90_000);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error === undefined ? resolvePromise() : reject(error);
    };
    const fail = error => {
      child.kill('SIGKILL');
      finish(error);
    };
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const event = JSON.parse(line);
          if (event.event !== 'SERVER_READY' || ready) continue;
          ready = true;
          child.kill('SIGTERM');
        } catch {
          // Other Daemon startup lines are not readiness events.
        }
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.once('error', fail);
    child.once('exit', code => {
      if (stdout.includes(forbiddenOutput) || stderr.includes(forbiddenOutput)) {
        fail(new Error('SERVER_PACKAGE_SMOKE_SECRET_LEAKED'));
        return;
      }
      if (!ready || code !== 0) {
        fail(new Error(`SERVER_PACKAGE_SMOKE_FAILED: exit=${code} ${stderr || stdout}`));
        return;
      }
      finish();
    });
  });
}

function cleanServerEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => (
    key !== 'CLAWEE_CODEX_RUNTIME_DESCRIPTOR'
    && key !== 'CLAWEE_DATA_DIR'
    && key !== 'CLAWEE_DEFAULT_CWD'
    && key !== 'CLAWEE_DEFAULT_PROJECT_ROOT'
    && !key.startsWith('CLAWEE_ENTERPRISE_')
  )));
}

async function reservePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null
        ? address.port
        : undefined;
      server.close(error => {
        if (error !== undefined) reject(error);
        else if (port === undefined) reject(new Error('SERVER_PACKAGE_PORT_UNAVAILABLE'));
        else resolvePromise(port);
      });
    });
  });
}

function createZipArchive(cwd, packageName, archivePath) {
  const escapedSource = join(cwd, packageName).replaceAll("'", "''");
  const escapedDestination = archivePath.replaceAll("'", "''");
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -LiteralPath '${escapedSource}' -DestinationPath '${escapedDestination}' -Force`
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('SERVER_PACKAGE_ARCHIVE_FAILED');
}

function listFiles(root, current) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) throw new Error(`SERVER_PACKAGE_SYMLINK_FORBIDDEN: ${path}`);
    if (entry.isDirectory()) files.push(...listFiles(root, path));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function listPaths(root, current) {
  const paths = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) throw new Error(`SERVER_PACKAGE_SYMLINK_FORBIDDEN: ${path}`);
    if (entry.isDirectory()) paths.push(`${relativePath}/`, ...listPaths(root, path));
    else if (entry.isFile()) paths.push(relativePath);
  }
  return paths;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function gitOutput(args) {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error(`Git command failed: git ${args.join(' ')}`);
  return result.stdout.trim();
}

function runStage(label, command, args, timeoutMs, env = process.env, cwd = projectRoot) {
  console.log(`[server-package] 开始：${label}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`SERVER_PACKAGE_STAGE_TIMEOUT: ${label}`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`SERVER_PACKAGE_STAGE_FAILED: ${label} (${code ?? signal})`));
        return;
      }
      console.log(`[server-package] 完成：${label}`);
      resolvePromise();
    });
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageServer();
}
