import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  assertCanPromote,
  buildVersionsCatalog,
  prepareReleaseLayout,
  publicObjectUrl,
  validateCosConfiguration
} from './cos-release-layout.mjs';
import { parseReleaseVersion } from './release-version.mjs';

const { parse: parseYaml } = createRequire(
  new URL('../client/apps/daemon/package.json', import.meta.url)
)('yaml');

export const coscliVersion = 'v1.0.9';
export const coscliSha256 = 'a07de5ba2800147a700ed29036b0c76a4229088cee68e1682d0eae19b638a915';
const coscliUrl = `https://github.com/tencentyun/coscli/releases/download/${coscliVersion}/coscli-${coscliVersion}-linux-amd64`;

export async function publishImmutableObjects(input) {
  const files = listFiles(input.versionRoot);
  if (files.length === 0) throw new Error('COS release directory is empty');
  const uploaded = [];
  for (const path of files) {
    const relativePath = relative(input.versionRoot, path).split(sep).join('/');
    const key = `${input.prefix}/releases/${input.tag}/${relativePath}`;
    const existing = await storedFileState(input.storage, key, path);
    if (existing.exists) {
      if (!existing.matches) {
        throw new Error(`Refusing to overwrite immutable COS object: ${key}`);
      }
      continue;
    }
    await input.storage.put(key, path, objectMetadata(key, 'immutable'), {
      forbidOverwrite: true
    });
    const verified = await storedFileState(input.storage, key, path);
    if (!verified.matches) {
      throw new Error(`COS object verification failed: ${key}`);
    }
    uploaded.push(key);
  }
  return uploaded;
}

export async function promoteRelease(input) {
  const { release, config, storage, versionRoot } = input;
  const channelRoot = `${config.prefix}/catalog/${release.channel}`;
  const latestKey = `${channelRoot}/latest.json`;
  const versionsKey = `${channelRoot}/versions.json`;
  const currentLatest = await readRemoteJson(storage, latestKey);
  const state = assertCanPromote(currentLatest, release);
  const currentVersions = await readRemoteJson(storage, versionsKey);
  const versions = buildVersionsCatalog({
    release,
    current: currentVersions,
    releaseUrl: publicObjectUrl(config, `releases/${release.tag}/release.json`)
  });
  const work = mkdtempSync(join(tmpdir(), 'clawee-cos-promote-'));
  try {
    const versionsPath = join(work, 'versions.json');
    const latestPath = join(work, 'latest.json');
    writeJson(versionsPath, versions);
    writeJson(latestPath, release);
    const changes = [
      ...listFiles(join(versionRoot, 'updates')).map(path => ({
        key: `${config.prefix}/updates/${release.channel}/${basename(path)}`,
        path
      })),
      { key: versionsKey, path: versionsPath },
      { key: latestKey, path: latestPath }
    ];
    const backups = new Map();
    for (const change of changes) backups.set(change.key, await storage.get(change.key));
    if (state === 'same') {
      const matches = changes.every(change => {
        const value = backups.get(change.key);
        return value !== null && sameContent(value, readFileSync(change.path));
      });
      if (matches) {
        for (const change of changes) await input.verify?.(change);
        return { promoted: false, channel: release.channel };
      }
    }
    if (currentLatest && [...backups.values()].some(value => value === null)) {
      throw new Error(
        'Current COS channel is incomplete; refusing promotion without a recoverable backup'
      );
    }
    const written = [];
    try {
      for (const change of changes) {
        written.push(change.key);
        await storage.put(change.key, change.path, objectMetadata(change.key, 'mutable'));
        const value = await storage.get(change.key);
        if (value === null || !sameContent(readFileSync(change.path), value)) {
          throw new Error(`COS channel object verification failed: ${change.key}`);
        }
        await input.verify?.(change);
      }
    } catch (error) {
      const recoveryErrors = [];
      for (const key of [...written].reverse()) {
        const backup = backups.get(key);
        if (backup === null) continue;
        const backupPath = join(work, 'backup', createHash('sha256').update(key).digest('hex'));
        mkdirSync(dirname(backupPath), { recursive: true });
        writeFileSync(backupPath, backup);
        try {
          await storage.put(key, backupPath, objectMetadata(key, 'mutable'));
          const restored = await storage.get(key);
          if (restored === null || !sameContent(restored, backup)) {
            throw new Error(`COS channel recovery verification failed: ${key}`);
          }
          await input.verify?.({ key, path: backupPath });
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      }
      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          [error, ...recoveryErrors],
          'COS channel promotion and recovery both failed'
        );
      }
      throw error;
    }
    return { promoted: true, channel: release.channel };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function bootstrapRelease(input) {
  const latestKey = `${input.config.prefix}/catalog/${input.release.channel}/latest.json`;
  if (await readRemoteJson(input.storage, latestKey) !== null) {
    return { bootstrapped: false, channel: input.release.channel };
  }
  await promoteRelease(input);
  return { bootstrapped: true, channel: input.release.channel };
}

export function validateStagedRelease(input) {
  const expected = parseReleaseVersion(input.version);
  if (!/^[0-9a-f]{40}$/.test(input.commit)) {
    throw new Error('Expected release commit must be a full Git SHA');
  }
  if (
    input.tag !== expected.tag
    || input.release.schemaVersion !== 1
    || input.release.product !== 'Clawee'
    || input.release.version !== expected.version
    || input.release.tag !== expected.tag
    || input.release.channel !== expected.channel
    || input.release.commit !== input.commit
    || !Array.isArray(input.release.artifacts)
  ) {
    throw new Error('Staged release identity does not match the requested release');
  }
  const actualUpdates = listFiles(join(input.versionRoot, 'updates'))
    .map(path => relative(join(input.versionRoot, 'updates'), path).split(sep).join('/'))
    .sort();
  const expectedUpdates = ['latest-arm64-mac.yml', 'latest-mac.yml', 'latest.yml'];
  if (JSON.stringify(actualUpdates) !== JSON.stringify(expectedUpdates)) {
    throw new Error(`Unexpected staged updater files: ${actualUpdates.join(', ')}`);
  }
}

export async function publishPreflight(input) {
  if (!/^[0-9a-f]{40}$/.test(input.targetSha)) throw new Error('Preflight target must be a full Git SHA');
  if (!/^\d+$/.test(String(input.runId))) throw new Error('Preflight run ID must be numeric');
  const files = listFiles(input.artifactDirectory);
  if (files.length === 0) throw new Error('Preflight artifact directory is empty');
  const names = new Set();
  const artifacts = files.map(path => {
    const relativePath = relative(input.artifactDirectory, path);
    if (dirname(relativePath) !== '.') {
      throw new Error(`Unexpected nested preflight artifact: ${relativePath}`);
    }
    const name = basename(path);
    if (names.has(name) || !isAllowedPreflightName(name)) {
      throw new Error(`Unexpected or duplicate preflight artifact: ${name}`);
    }
    names.add(name);
    if (/^clawee-desktop-build-manifest-.*\.json$/.test(name)) {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      if (manifest.commit !== input.targetSha || manifest.officialRelease !== false) {
        throw new Error(`Invalid Desktop preflight manifest: ${name}`);
      }
    }
    if (/\.tar\.gz$/.test(name)) verifyServerPreflightArchive(path, input.targetSha);
    return { name, path, ...fileDetails(path) };
  });
  assertCompletePreflight(names);
  const work = mkdtempSync(join(tmpdir(), 'clawee-cos-preflight-'));
  try {
    const manifestPath = join(work, 'preflight-manifest.json');
    writeJson(manifestPath, {
      schemaVersion: 1,
      product: 'Clawee',
      commit: input.targetSha,
      runId: String(input.runId),
      createdAt: new Date(input.createdAt ?? Date.now()).toISOString(),
      artifacts: artifacts.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))
    });
    const root = `${input.prefix}/preflight/${input.targetSha}/${input.runId}`;
    const manifestKey = `${root}/preflight-manifest.json`;
    await input.storage.put(manifestKey, manifestPath, objectMetadata(manifestKey, 'preflight'));
    const verified = await storedFileState(input.storage, manifestKey, manifestPath);
    if (!verified.matches) {
      throw new Error(`COS preflight object verification failed: ${manifestKey}`);
    }
    return { root, manifestPath: `${root}/preflight-manifest.json` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function verifyPublicImmutableRelease(input) {
  const files = [
    join(input.versionRoot, 'release.json'),
    ...listFiles(join(input.versionRoot, 'updates'))
  ];
  for (const path of files) {
    const relativePath = relative(input.versionRoot, path).split(sep).join('/');
    await verifyPublicFile({
      fetchImpl: input.fetchImpl ?? fetch,
      url: publicObjectUrl(input.config, `releases/${input.release.tag}/${relativePath}`),
      expected: readFileSync(path),
      cacheControl: 'public,max-age=31536000,immutable',
      contentType: contentType(path)
    });
  }
  const referencedUrls = new Set();
  for (const path of listFiles(join(input.versionRoot, 'updates'))) {
    const document = parseYaml(readFileSync(path, 'utf8'));
    for (const file of document.files) {
      if (referencedUrls.has(file.url)) continue;
      referencedUrls.add(file.url);
      await verifyPublicRange({
        fetchImpl: input.fetchImpl ?? fetch,
        url: file.url,
        bytes: file.size,
        cacheControl: 'public,max-age=31536000,immutable',
        contentType: contentType(file.url)
      });
    }
  }
  for (const artifact of input.release.artifacts.filter(item => (
    item.format === 'blockmap'
    || item.format === 'tar.gz'
    || (['dmg', 'exe', 'zip'].includes(item.format) && !referencedUrls.has(item.downloadUrl))
  ))) {
    await verifyPublicRange({
      fetchImpl: input.fetchImpl ?? fetch,
      url: artifact.downloadUrl,
      bytes: artifact.bytes,
      cacheControl: 'public,max-age=31536000,immutable',
      contentType: contentType(artifact.name)
    });
  }
}

export async function verifyPublicChannel(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const latest = await fetchPublicJson(
    fetchImpl,
    publicObjectUrl(input.config, `catalog/${input.release.channel}/latest.json`),
    'no-cache,max-age=0,must-revalidate'
  );
  if (JSON.stringify(latest) !== JSON.stringify(input.release)) {
    throw new Error('Public latest.json does not match the promoted release');
  }
  const versions = await fetchPublicJson(
    fetchImpl,
    publicObjectUrl(input.config, `catalog/${input.release.channel}/versions.json`),
    'no-cache,max-age=0,must-revalidate'
  );
  if (!versions.versions?.some(item => item.version === input.release.version && item.tag === input.release.tag)) {
    throw new Error('Public versions.json does not contain the promoted release');
  }
  for (const path of listFiles(join(input.versionRoot, 'updates'))) {
    await verifyPublicFile({
      fetchImpl,
      url: publicObjectUrl(
        input.config,
        `updates/${input.release.channel}/${basename(path)}`
      ),
      expected: readFileSync(path),
      cacheControl: 'no-cache,max-age=0,must-revalidate',
      contentType: 'application/yaml; charset=utf-8'
    });
  }
}

export async function installCoscli(directory) {
  if (process.env.COSCLI_PATH?.trim()) return resolve(process.env.COSCLI_PATH.trim());
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Pinned COSCLI installation only supports Linux amd64 CI runners');
  }
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `coscli-${coscliVersion}`);
  const response = await fetch(coscliUrl);
  if (!response.ok) throw new Error(`COSCLI download failed with HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== coscliSha256) throw new Error(`COSCLI checksum mismatch: ${digest}`);
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function createCoscliStorage(input) {
  const config = validateCosConfiguration(input);
  for (const name of ['secretId', 'secretKey']) {
    if (!input[name]?.trim()) throw new Error(`COS credential ${name} is required`);
  }
  const temporaryRoot = resolve(input.temporaryDirectory ?? tmpdir());
  mkdirSync(temporaryRoot, { recursive: true });
  const work = mkdtempSync(join(temporaryRoot, 'clawee-coscli-'));
  const configPath = join(work, 'cos.yaml');
  writeFileSync(configPath, [
    'cos:',
    '  base:',
    `    secretid: ${JSON.stringify(input.secretId.trim())}`,
    `    secretkey: ${JSON.stringify(input.secretKey.trim())}`,
    '    sessiontoken: ""',
    '    protocol: "https"',
    '    mode: "SecretKey"',
    '  buckets:',
    `    - name: ${JSON.stringify(config.bucket)}`,
    `      alias: ${JSON.stringify(config.bucket)}`,
    `      region: ${JSON.stringify(config.region)}`,
    `      endpoint: ${JSON.stringify(config.uploadEndpoint ?? `cos.${config.region}.myqcloud.com`)}`,
    '      ofs: false',
    '      customized: false',
    ''
  ].join('\n'), { mode: 0o600 });
  const common = ['-c', configPath, '--init-skip', '--bucket-type', 'COS'];
  const run = (args, logging = false) => {
    const loggingArgs = logging
      ? ['--log-path', join(work, 'bucket-versioning.log')]
      : ['--disable-log'];
    const result = spawnSync(input.coscliPath, [...args, ...loggingArgs, ...common], {
      encoding: 'utf8', timeout: 30 * 60_000
    });
    if (result.status !== 0) {
      const failure = result.error?.code ?? result.signal ?? result.status;
      throw new Error(
        `COSCLI failed (${failure}): ${redactCoscliOutput(
          result.stderr || result.stdout,
          input
        )}`
      );
    }
    return `${result.stdout}\n${result.stderr}`;
  };
  const stat = async key => {
    const logPath = join(work, 'stat-logs', `${createHash('sha256').update(key).digest('hex')}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    rmSync(logPath, { force: true });
    const result = spawnSync(input.coscliPath, [
      'stat', `cos://${config.bucket}/${key}`,
      '--log-path', logPath,
      ...common
    ], { encoding: 'utf8', timeout: 60_000 });
    const output = `${result.stderr}\n${result.stdout}\n${
      existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    }`;
    if (result.status !== 0) {
      if (/NoSuchKey|StatusCode:\s*404|status code\s*404|\b404\b/i.test(output)) {
        return null;
      }
      throw new Error(`COS object stat failed: ${key}`);
    }
    const bytes = /Content-Length:\s*(\d+)/i.exec(output)?.[1];
    if (bytes === undefined) throw new Error(`COS object stat is missing Content-Length: ${key}`);
    const sha256 = /x-cos-meta-sha256:\s*([0-9a-f]{64})/i.exec(output)?.[1] ?? null;
    return { bytes: Number(bytes), sha256 };
  };
  return {
    async assertVersioningEnabled() {
      const output = run([
        'bucket-versioning', '--method', 'get', `cos://${config.bucket}`
      ], true);
      if (!/bucket versioning status is Enabled/i.test(output)) {
        throw new Error(`COS bucket versioning is not enabled: ${config.bucket}`);
      }
    },
    async get(key) {
      if (await stat(key) === null) return null;
      const path = join(work, 'downloads', createHash('sha256').update(key).digest('hex'));
      mkdirSync(dirname(path), { recursive: true });
      const result = spawnSync(input.coscliPath, [
        'cp', `cos://${config.bucket}/${key}`, path,
        '--disable-checksum=false', '--process-log=false', '--fail-output=false',
        '--disable-log',
        ...common
      ], { encoding: 'utf8', timeout: 30 * 60_000 });
      if (result.status !== 0) {
        const output = `${result.stderr}\n${result.stdout}`;
        if (/NoSuchKey|StatusCode:\s*404|status code\s*404|\b404\b/i.test(output)) {
          return null;
        }
        throw new Error(`COS object read failed: ${key}`);
      }
      return readFileSync(path);
    },
    stat,
    async put(key, path, metadata, options = {}) {
      const details = fileDetails(path);
      console.log(`[cos-publish] key=${key} bytes=${details.bytes} sha256=${details.sha256}`);
      run([
        'cp', path, `cos://${config.bucket}/${key}`,
        '--disable-checksum=false', '--check-point=true',
        '--err-retry-num=5', '--process-log=false', '--fail-output=false',
        ...(options.forbidOverwrite ? ['--forbid-overwrite=true'] : []),
        '--meta', Object.entries({
          ...metadata,
          'x-cos-meta-sha256': details.sha256
        }).map(([name, value]) => `${name}:${value}`).join('#')
      ]);
      console.log(`[cos-publish] uploaded key=${key}`);
    },
    close() {
      rmSync(work, { recursive: true, force: true });
    }
  };
}

function objectMetadata(key, scope) {
  const cache = scope === 'immutable'
    ? 'public,max-age=31536000,immutable'
    : scope === 'preflight'
      ? 'private,no-store'
      : 'no-cache,max-age=0,must-revalidate';
  return { 'Cache-Control': cache, 'Content-Type': contentType(key) };
}

function contentType(key) {
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  if (key.endsWith('.yml')) return 'application/yaml; charset=utf-8';
  if (key.endsWith('.zip')) return 'application/zip';
  if (key.endsWith('.tar.gz')) return 'application/gzip';
  if (key.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (key.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (key.endsWith('.txt') || key.endsWith('SHA256SUMS')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function verifyPublicFile(input) {
  const response = await fetchWithRetry(input.fetchImpl, cacheBust(input.url), {
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!response.ok) throw new Error(`Public object returned HTTP ${response.status}: ${input.url}`);
  assertPublicHeaders(response, input);
  const actual = Buffer.from(await response.arrayBuffer());
  if (!sameContent(actual, input.expected)) throw new Error(`Public object content mismatch: ${input.url}`);
}

async function verifyPublicRange(input) {
  const head = await fetchWithRetry(input.fetchImpl, cacheBust(input.url), { method: 'HEAD' });
  if (!head.ok) throw new Error(`Public object HEAD returned HTTP ${head.status}: ${input.url}`);
  assertPublicHeaders(head, input);
  if (Number(head.headers.get('content-length')) !== input.bytes) {
    throw new Error(`Public object Content-Length mismatch: ${input.url}`);
  }
  const range = await fetchWithRetry(input.fetchImpl, cacheBust(input.url), {
    headers: { Range: 'bytes=0-0', 'Cache-Control': 'no-cache' }
  });
  if (range.status !== 206 || Buffer.from(await range.arrayBuffer()).length !== 1) {
    throw new Error(`Public object does not support byte ranges: ${input.url}`);
  }
}

async function fetchPublicJson(fetchImpl, url, cacheControl) {
  const response = await fetchWithRetry(fetchImpl, cacheBust(url), {
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!response.ok) throw new Error(`Public JSON returned HTTP ${response.status}: ${url}`);
  assertPublicHeaders(response, {
    url,
    cacheControl,
    contentType: 'application/json; charset=utf-8'
  });
  try {
    return await response.json();
  } catch {
    throw new Error(`Public JSON is invalid: ${url}`);
  }
}

async function fetchWithRetry(fetchImpl, url, options) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetchImpl(url, options);
      if (response.ok || response.status === 206) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Public object request failed: ${url}`, { cause: lastError });
}

function assertPublicHeaders(response, input) {
  const cache = normalizeCacheControl(response.headers.get('cache-control'));
  if (cache !== normalizeCacheControl(input.cacheControl)) {
    throw new Error(`Public object Cache-Control mismatch: ${input.url}`);
  }
  const type = response.headers.get('content-type')?.toLowerCase();
  if (type !== input.contentType.toLowerCase()) {
    throw new Error(`Public object Content-Type mismatch: ${input.url}`);
  }
}

function normalizeCacheControl(value) {
  return value
    ?.split(',')
    .map(directive => directive.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
}

function cacheBust(url) {
  const value = new URL(url);
  value.searchParams.set('clawee_verify', `${Date.now()}`);
  return value;
}

function redactCoscliOutput(output, input) {
  let value = String(output).slice(-4_000);
  for (const secret of [input.secretId, input.secretKey]) {
    if (secret) value = value.replaceAll(secret, '[REDACTED]');
  }
  return value;
}

function verifyServerPreflightArchive(path, targetSha) {
  let result;
  for (const name of ['./release-manifest.json', 'release-manifest.json']) {
    result = spawnSync('tar', ['-xOf', path, name], { encoding: 'utf8', timeout: 30_000 });
    if (result.status === 0) break;
  }
  if (result?.status !== 0) throw new Error(`Server preflight manifest is missing: ${basename(path)}`);
  const manifest = JSON.parse(result.stdout);
  if (manifest.commit !== targetSha) throw new Error(`Server preflight commit mismatch: ${basename(path)}`);
}

function isAllowedPreflightName(name) {
  return /^(?:Clawee-(?:Setup-)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:-arm64)?\.(?:dmg|zip|exe)(?:\.blockmap)?|latest(?:-arm64)?(?:-mac)?\.yml|clawee-desktop-build-manifest-(?:mac|win)-(?:x64|arm64)\.json|clawee-server-preflight-linux-(?:amd64|arm64)\.tar\.gz)$/.test(name);
}

function assertCompletePreflight(names) {
  const exact = [
    'latest.yml',
    'latest-mac.yml',
    'latest-arm64-mac.yml',
    'clawee-desktop-build-manifest-mac-x64.json',
    'clawee-desktop-build-manifest-mac-arm64.json',
    'clawee-desktop-build-manifest-win-x64.json',
    'clawee-server-preflight-linux-amd64.tar.gz',
    'clawee-server-preflight-linux-arm64.tar.gz'
  ];
  const missing = exact.filter(name => !names.has(name));
  const values = [...names];
  if (!values.some(name => /^Clawee-.*\.dmg$/.test(name) && !name.endsWith('-arm64.dmg'))) {
    missing.push('macOS x64 DMG');
  }
  if (!values.some(name => /^Clawee-.*-arm64\.dmg$/.test(name))) {
    missing.push('macOS arm64 DMG');
  }
  if (!values.some(name => /^Clawee-Setup-.*\.exe$/.test(name))) {
    missing.push('Windows x64 EXE');
  }
  for (const name of values.filter(value => /^Clawee-.*\.dmg$/.test(value))) {
    const stem = name.slice(0, -'.dmg'.length);
    const zip = [`${stem}.zip`, `${stem}-mac.zip`].find(candidate => names.has(candidate));
    if (zip === undefined) {
      missing.push(`${stem}.zip or ${stem}-mac.zip`);
    } else if (!names.has(`${zip}.blockmap`)) {
      missing.push(`${zip}.blockmap`);
    }
  }
  for (const name of values.filter(value => /^Clawee-Setup-.*\.exe$/.test(value))) {
    if (!names.has(`${name}.blockmap`)) missing.push(`${name}.blockmap`);
  }
  if (missing.length > 0) throw new Error(`Preflight artifact set is incomplete: ${missing.join(', ')}`);
}

async function readRemoteJson(storage, key) {
  const content = await storage.get(key);
  if (content === null) return null;
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error(`Invalid JSON in COS object: ${key}`);
  }
}

function listFiles(root) {
  if (!existsSync(root)) throw new Error(`Directory does not exist: ${root}`);
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`Upload directories cannot contain symlinks: ${path}`);
    return info.isDirectory() ? listFiles(path) : info.isFile() ? [path] : [];
  }).sort();
}

function sameContent(left, right) {
  return left.length === right.length
    && createHash('sha256').update(left).digest('hex') === createHash('sha256').update(right).digest('hex');
}

async function storedFileState(storage, key, path) {
  const local = fileDetails(path);
  if (typeof storage.stat === 'function') {
    const remote = await storage.stat(key);
    if (remote === null) return { exists: false, matches: false };
    if (remote.sha256 !== null) {
      return {
        exists: true,
        matches: remote.bytes === local.bytes && remote.sha256 === local.sha256
      };
    }
  }
  const remote = await storage.get(key);
  return {
    exists: remote !== null,
    matches: remote !== null && sameContent(readFileSync(path), remote)
  };
}

function fileDetails(path) {
  const content = readFileSync(path);
  return { bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function requiredOption(args, name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function environmentConfiguration() {
  return validateCosConfiguration({
    bucket: process.env.COS_BUCKET,
    region: process.env.COS_REGION,
    publicBaseUrl: process.env.COS_PUBLIC_BASE_URL,
    prefix: process.env.COS_PREFIX,
    uploadEndpoint: process.env.COS_UPLOAD_ENDPOINT
  });
}

async function withStorage(config, action) {
  const directory = process.env.RUNNER_TEMP?.trim() || tmpdir();
  const coscliPath = await installCoscli(directory);
  const storage = createCoscliStorage({
    ...config,
    coscliPath,
    temporaryDirectory: process.env.RUNNER_TEMP,
    secretId: process.env.TENCENT_CLOUD_SECRET_ID,
    secretKey: process.env.TENCENT_CLOUD_SECRET_KEY
  });
  try {
    await storage.assertVersioningEnabled();
    return await action(storage);
  } finally {
    storage.close();
  }
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log('Usage: node scripts/cos-publish.mjs <prepare-release|release-immutable|release-bootstrap|release-promote|preflight> [options]');
    return;
  }
  const config = environmentConfiguration();
  if (command === 'prepare-release') {
    const result = prepareReleaseLayout({
      ...config,
      artifactDirectory: requiredOption(args, '--artifacts'),
      outputDirectory: requiredOption(args, '--stage'),
      manifestPath: requiredOption(args, '--manifest'),
      releaseNotesPath: requiredOption(args, '--release-notes'),
      version: requiredOption(args, '--version'),
      tag: requiredOption(args, '--tag'),
      commit: requiredOption(args, '--commit'),
      publishedAt: requiredOption(args, '--published-at')
    });
    console.log(`[cos-publish] prepared ${result.release.tag} channel=${result.channel}`);
    return;
  }
  if (['release-immutable', 'release-bootstrap', 'release-promote'].includes(command)) {
    const stage = requiredOption(args, '--stage');
    const tag = requiredOption(args, '--tag');
    const versionRoot = resolve(stage, 'releases', tag);
    const release = JSON.parse(readFileSync(join(versionRoot, 'release.json'), 'utf8'));
    validateStagedRelease({
      release,
      versionRoot,
      tag,
      version: requiredOption(args, '--version'),
      commit: requiredOption(args, '--commit')
    });
    if (command === 'release-immutable') {
      await withStorage(config, async storage => {
        const current = await readRemoteJson(
          storage,
          `${config.prefix}/catalog/${release.channel}/latest.json`
        );
        assertCanPromote(current, release);
        const versions = await readRemoteJson(
          storage,
          `${config.prefix}/catalog/${release.channel}/versions.json`
        );
        buildVersionsCatalog({
          release,
          current: versions,
          releaseUrl: publicObjectUrl(config, `releases/${release.tag}/release.json`)
        });
        await publishImmutableObjects({
          storage, versionRoot, prefix: config.prefix, tag
        });
        await verifyPublicImmutableRelease({ config, release, versionRoot });
      });
    } else {
      await withStorage(config, async storage => {
        const input = {
          storage,
          versionRoot,
          config,
          release,
          verify: publicMutableVerifier(config)
        };
        if (command === 'release-bootstrap') {
          await bootstrapRelease(input);
          return;
        }
        if (args.includes('--verify-immutable')) {
          await verifyPublicImmutableRelease({ config, release, versionRoot });
        }
        await promoteRelease(input);
      });
    }
    return;
  }
  if (command === 'preflight') {
    await withStorage(config, storage => publishPreflight({
      storage,
      prefix: config.prefix,
      artifactDirectory: requiredOption(args, '--artifacts'),
      targetSha: requiredOption(args, '--target-sha'),
      runId: requiredOption(args, '--run-id')
    }));
    return;
  }
  throw new Error(`Unsupported COS publish command: ${command}`);
}

function publicMutableVerifier(config) {
  return change => verifyPublicFile({
    fetchImpl: fetch,
    url: publicObjectUrl(
      config,
      change.key.slice(config.prefix.length + 1)
    ),
    expected: readFileSync(change.path),
    cacheControl: 'no-cache,max-age=0,must-revalidate',
    contentType: contentType(change.key)
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli();
}
