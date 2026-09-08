import { createHash } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANAGED_ROOTS = ['bin', 'daemon', 'web', 'codex-runtime', 'deployment'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export async function startPackagedServer(
  argv = process.argv.slice(2),
  moduleUrl = import.meta.url
) {
  const configPath = parseConfigArgument(argv);
  const packageRoot = resolve(dirname(fileURLToPath(moduleUrl)), '..');
  const manifest = readBuildManifest(join(
    packageRoot,
    'deployment/server-build-manifest.json'
  ));
  assertPackageTarget(manifest, process.platform, process.arch);
  await verifyPackageIntegrity(packageRoot, manifest);
  assertRuntimeFormal(packageRoot, manifest);
  assertNativeDependency(packageRoot);

  const configModule = await import(pathToFileURL(join(
    packageRoot,
    'daemon/dist/server-mode/config.js'
  )).href);
  const config = configModule.readPackagedServerConfiguration(configPath);
  process.env.CLAWEE_CODEX_RUNTIME_DESCRIPTOR = JSON.stringify(
    createRuntimeDescriptor(packageRoot, manifest, config.dataDir)
  );
  process.argv = [
    process.execPath,
    join(packageRoot, 'daemon/dist/main.js'),
    '--server',
    `--server-config=${config.configPath}`,
    `--web-dist-dir=${join(packageRoot, 'web')}`
  ];
  await import(pathToFileURL(join(packageRoot, 'daemon/dist/main.js')).href);
}

export function parseConfigArgument(argv) {
  let value;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--config') {
      if (value !== undefined || index + 1 >= argv.length) {
        throw serverError('SERVER_CONFIG_INVALID');
      }
      value = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith('--config=')) {
      if (value !== undefined) throw serverError('SERVER_CONFIG_INVALID');
      value = argument.slice('--config='.length);
      continue;
    }
    throw serverError('SERVER_CONFIG_INVALID');
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw serverError('SERVER_CONFIG_INVALID');
  }
  return resolve(value);
}

export function readBuildManifest(path) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw serverError('SERVER_PACKAGE_MANIFEST_INVALID');
  }
  if (
    !isRecord(manifest)
    || manifest.schemaVersion !== 1
    || manifest.product !== 'clawee-server'
    || typeof manifest.version !== 'string'
    || typeof manifest.platform !== 'string'
    || typeof manifest.arch !== 'string'
    || !Number.isSafeInteger(manifest.nodeMajor)
    || manifest.nodeMajor < 1
    || typeof manifest.codexRuntimeId !== 'string'
    || typeof manifest.codexRuntimeVersion !== 'string'
    || !SHA256_PATTERN.test(manifest.codexRuntimeHash)
    || !Array.isArray(manifest.files)
    || manifest.files.some(entry => (
      !isRecord(entry)
      || typeof entry.path !== 'string'
      || !SHA256_PATTERN.test(entry.sha256)
    ))
  ) {
    throw serverError('SERVER_PACKAGE_MANIFEST_INVALID');
  }
  return manifest;
}

export async function verifyPackageIntegrity(packageRoot, manifest) {
  const actualPaths = listManagedFiles(packageRoot);
  const expectedPaths = manifest.files.map(entry => entry.path).sort();
  if (
    new Set(expectedPaths).size !== expectedPaths.length
    || JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)
  ) {
    throw serverError('SERVER_PACKAGE_INTEGRITY_FAILED');
  }
  for (const entry of manifest.files) {
    if (await hashFile(join(packageRoot, entry.path)) !== entry.sha256) {
      throw serverError('SERVER_PACKAGE_INTEGRITY_FAILED');
    }
  }
}

function assertPackageTarget(manifest, platform, arch) {
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw serverError('SERVER_PACKAGE_TARGET_MISMATCH');
  }
}

function assertRuntimeFormal(packageRoot, buildManifest) {
  let runtimeManifest;
  let runtimePackage;
  try {
    runtimeManifest = JSON.parse(readFileSync(join(
      packageRoot,
      'deployment/codex-runtime.json'
    ), 'utf8'));
    runtimePackage = JSON.parse(readFileSync(join(
      packageRoot,
      'codex-runtime/codex-package.json'
    ), 'utf8'));
  } catch {
    throw serverError('SERVER_RUNTIME_NOT_FORMAL');
  }
  const target = Object.values(runtimeManifest.targets ?? {}).find(candidate => (
    isRecord(candidate) && candidate.targetTriple === runtimePackage.target
  ));
  if (
    !isRecord(target)
    || target.formalRelease !== true
    || runtimeManifest.runtimeId !== buildManifest.codexRuntimeId
    || runtimeManifest.codexVersion !== buildManifest.codexRuntimeVersion
  ) {
    throw serverError('SERVER_RUNTIME_NOT_FORMAL');
  }
}

function assertNativeDependency(packageRoot) {
  try {
    const require = createRequire(join(packageRoot, 'daemon/package.json'));
    const Database = require('better-sqlite3');
    const database = new Database(':memory:');
    database.close();
  } catch {
    throw serverError('SERVER_NATIVE_DEPENDENCY_INVALID');
  }
}

function createRuntimeDescriptor(packageRoot, manifest, dataDir) {
  const runtimePackage = JSON.parse(readFileSync(join(
    packageRoot,
    'codex-runtime/codex-package.json'
  ), 'utf8'));
  const runtimeManifest = JSON.parse(readFileSync(join(
    packageRoot,
    'deployment/codex-runtime.json'
  ), 'utf8'));
  const homePath = join(dataDir, 'codex-home');
  return {
    candidate: {
      runtimeId: manifest.codexRuntimeId,
      source: 'embedded-package',
      codexVersion: manifest.codexRuntimeVersion,
      releaseTag: runtimeManifest.releaseTag,
      target: runtimePackage.target,
      layoutVersion: runtimeManifest.layoutVersion,
      entryPath: join(packageRoot, 'codex-runtime', runtimePackage.entrypoint),
      homePath,
      contentSha256: manifest.codexRuntimeHash,
      minimumClaweeVersion: runtimeManifest.minimumClaweeVersion,
      migrationSourceHome: null
    },
    previous: null,
    claweeVersion: manifest.version
  };
}

function listManagedFiles(packageRoot) {
  return MANAGED_ROOTS.flatMap(root => listFiles(packageRoot, join(packageRoot, root)))
    .filter(path => path !== 'deployment/server-build-manifest.json')
    .sort();
}

function listFiles(packageRoot, current) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    throw serverError('SERVER_PACKAGE_INTEGRITY_FAILED');
  }
  for (const entry of entries) {
    const path = join(current, entry.name);
    const relativePath = relative(packageRoot, path).replaceAll('\\', '/');
    const info = lstatSync(path);
    if (info.isSymbolicLink() || isAbsolute(relativePath) || relativePath.startsWith('../')) {
      throw serverError('SERVER_PACKAGE_INTEGRITY_FAILED');
    }
    if (info.isDirectory()) files.push(...listFiles(packageRoot, path));
    else if (info.isFile()) files.push(relativePath);
    else throw serverError('SERVER_PACKAGE_INTEGRITY_FAILED');
  }
  return files;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function serverError(code) {
  return new Error(code);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (
  process.argv[1] !== undefined
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
  startPackagedServer().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/^([A-Z][A-Z0-9_]+)/)?.[1]
      ?? 'SERVER_START_FAILED';
    console.error(JSON.stringify({ event: 'SERVER_START_FAILED', code }));
    process.exitCode = 1;
  });
}
