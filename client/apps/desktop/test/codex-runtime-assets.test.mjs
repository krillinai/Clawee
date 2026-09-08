import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { c as createTar } from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  codexRuntimeReleaseUrl,
  downloadCodexRuntimeAsset,
  prepareCodexRuntime,
  pruneCodexRuntimeArchiveCache,
  verifyCodexRuntimeDirectory
} from '../scripts/codex-runtime-assets.mjs';

const projectRoot = resolve(process.cwd(), '../..');
const baseManifest = JSON.parse(readFileSync(
  resolve(projectRoot, 'config/codex-runtime.json'),
  'utf8'
));
const targetTriple = 'aarch64-apple-darwin';
const executableFiles = [
  'bin/codex',
  'bin/codex-code-mode-host',
  'codex-path/rg',
  'codex-resources/zsh/bin/zsh'
];
const certificate = Buffer.from('clawee-test-apple-certificate');
const certificateSha256 = hashBuffer(certificate);
const tempRoots = [];
const unixIt = process.platform === 'win32' ? it.skip : it;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Codex Runtime assets', () => {
  it('builds_the_release_url_from_the_pinned_tag_and_asset_name', () => {
    expect(codexRuntimeReleaseUrl(
      baseManifest,
      baseManifest.targets[targetTriple]
    )).toBe(
      'https://github.com/openai/codex/releases/download/rust-v0.151.0/'
      + 'codex-package-aarch64-apple-darwin.tar.gz'
    );
  });

  it('downloads_the_exact_release_asset_without_the_releases_api', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-codex-download-'));
    tempRoots.push(root);
    const destination = join(root, 'runtime.tar.gz');
    const releaseUrl = codexRuntimeReleaseUrl(
      baseManifest,
      baseManifest.targets[targetTriple]
    );
    const downloadUrl =
      'https://release-assets.githubusercontent.com/runtime.tar.gz?signed=1';
    const contents = Buffer.from('codex-runtime');
    const fetchMock = vi.fn(async (url, init) => {
      if (url === releaseUrl) {
        return new Response(null, {
          status: 302,
          headers: { Location: downloadUrl }
        });
      }
      if (url === downloadUrl && init.headers.Range === 'bytes=0-0') {
        return new Response(contents.subarray(0, 1), {
          status: 206,
          headers: {
            'Content-Range': `bytes 0-0/${contents.length}`
          }
        });
      }
      if (
        url === downloadUrl
        && init.headers.Range === `bytes=0-${contents.length - 1}`
      ) {
        return new Response(contents, {
          status: 206,
          headers: {
            'Content-Range':
              `bytes 0-${contents.length - 1}/${contents.length}`
          }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await downloadCodexRuntimeAsset(releaseUrl, destination);

    expect(readFileSync(destination)).toEqual(contents);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContainEqual(
      expect.stringContaining('api.github.com')
    );
  });

  it('keeps_only_the_archive_for_the_current_bundled_Runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-codex-cache-'));
    tempRoots.push(root);
    writeFileSync(join(root, 'rust-v0.146.0-old.tar.gz'), 'old');
    writeFileSync(join(root, 'rust-v0.151.0-current.tar.gz'), 'current');
    mkdirSync(join(root, 'stale-download'));

    pruneCodexRuntimeArchiveCache(
      root,
      'rust-v0.151.0-current.tar.gz'
    );

    expect(readdirSync(root)).toEqual([
      'rust-v0.151.0-current.tar.gz'
    ]);
  });

  unixIt('rejects_tampered_archive_wrong_target_missing_helper_and_bad_signer', async () => {
    const tampered = await createFixture();
    const originalHash = hashFile(tampered.archivePath);
    writeFileSync(tampered.archivePath, Buffer.concat([
      readFileSync(tampered.archivePath),
      Buffer.from('tampered')
    ]));
    await expect(prepareFixture(tampered, {
      archiveSha256: originalHash
    })).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_ARCHIVE_HASH_MISMATCH'
    });

    const wrongTarget = await createFixture({
      metadataTarget: 'x86_64-apple-darwin'
    });
    await expect(prepareFixture(wrongTarget)).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_METADATA_MISMATCH'
    });

    const missingHelpers = await createFixture({
      omittedFiles: ['bin/codex-code-mode-host', 'codex-path/rg']
    });
    await expect(prepareFixture(missingHelpers)).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_FILE_LIST_MISMATCH'
    });

    const badSigner = await createFixture();
    await expect(prepareFixture(badSigner, {
      commandRunner: createCommandRunner({
        signingIdentity: 'Developer ID Application: Untrusted Example (BADTEAM)'
      })
    })).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_TRUST_MISMATCH'
    });
  });

  unixIt('stages_only_one_target_and_preserves_unix_execute_bits', async () => {
    const fixture = await createFixture();
    mkdirSync(fixture.stagingDirectory, { recursive: true });
    writeFileSync(join(fixture.stagingDirectory, 'stale-target'), 'old');

    const result = await prepareFixture(fixture);

    expect(result).toMatchObject({
      runtimeId: baseManifest.runtimeId,
      target: targetTriple,
      entrypoint: 'bin/codex',
      archiveSha256: hashFile(fixture.archivePath),
      fileCount: 5
    });
    expect(listFiles(fixture.stagingDirectory)).toEqual([
      'bin/codex',
      'bin/codex-code-mode-host',
      'codex-package.json',
      'codex-path/rg',
      'codex-resources/zsh/bin/zsh'
    ]);
    for (const path of executableFiles) {
      expect(statSync(join(fixture.stagingDirectory, path)).mode & 0o111)
        .toBe(0o111);
    }
  });

  unixIt('rejects_wrong_architecture_and_missing_unix_execute_bits', async () => {
    const wrongArchitecture = await createFixture({
      binaryArch: 'x64'
    });
    await expect(prepareFixture(wrongArchitecture)).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_ARCHITECTURE_MISMATCH'
    });

    const missingExecuteBits = await createFixture({
      nonExecutableFiles: ['codex-path/rg']
    });
    await expect(prepareFixture(missingExecuteBits)).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_NOT_EXECUTABLE'
    });
  });

  it('rejects_local_archives_outside_explicit_test_mode', async () => {
    const fixture = await createFixture();
    const manifest = manifestForArchive(fixture.archivePath);

    await expect(prepareCodexRuntime({
      manifest,
      platform: 'darwin',
      arch: 'arm64',
      stagingDirectory: fixture.stagingDirectory,
      cacheDirectory: fixture.cacheDirectory,
      archivePath: fixture.archivePath,
      commandRunner: createCommandRunner()
    })).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_LOCAL_SOURCE_FORBIDDEN'
    });
  });

  unixIt('uses_the_system_command_runner_by_default_for_direct_verification', async () => {
    const fixture = await createFixture();
    const manifest = manifestForArchive(fixture.archivePath);
    const target = manifest.targets[targetTriple];

    await expect(verifyCodexRuntimeDirectory({
      directory: join(dirname(fixture.archivePath), 'source'),
      manifest,
      target
    })).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_COMMAND_FAILED'
    });
  });

  unixIt('uses_the_system_command_runner_by_default_when_preparing', async () => {
    const fixture = await createFixture();
    const manifest = manifestForArchive(fixture.archivePath);

    await expect(prepareCodexRuntime({
      manifest,
      platform: 'darwin',
      arch: 'arm64',
      stagingDirectory: fixture.stagingDirectory,
      cacheDirectory: fixture.cacheDirectory,
      archivePath: fixture.archivePath,
      testMode: true
    })).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_COMMAND_FAILED'
    });
  });
});

async function createFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clawee-codex-runtime-'));
  tempRoots.push(root);
  const sourceDirectory = join(root, 'source');
  const archivePath = join(root, 'codex-runtime.tar.gz');
  const stagingDirectory = join(root, 'stage', 'codex-runtime');
  const cacheDirectory = join(root, 'cache');
  const omittedFiles = new Set(options.omittedFiles ?? []);
  const nonExecutableFiles = new Set(options.nonExecutableFiles ?? []);
  const metadata = {
    layoutVersion: 1,
    version: baseManifest.codexVersion,
    target: options.metadataTarget ?? targetTriple,
    variant: 'codex',
    entrypoint: 'bin/codex',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path'
  };

  writeFixtureFile(
    sourceDirectory,
    'codex-package.json',
    Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
    0o644
  );
  for (const path of executableFiles) {
    if (omittedFiles.has(path)) continue;
    writeFixtureFile(
      sourceDirectory,
      path,
      machoBinary(options.binaryArch ?? 'arm64'),
      nonExecutableFiles.has(path) ? 0o644 : 0o755
    );
  }

  await createTar({
    cwd: sourceDirectory,
    file: archivePath,
    gzip: true,
    portable: true
  }, listFiles(sourceDirectory));

  return {
    archivePath,
    cacheDirectory,
    stagingDirectory
  };
}

async function prepareFixture(fixture, options = {}) {
  const manifest = manifestForArchive(
    fixture.archivePath,
    options.archiveSha256
  );
  return prepareCodexRuntime({
    manifest,
    platform: 'darwin',
    arch: 'arm64',
    stagingDirectory: fixture.stagingDirectory,
    cacheDirectory: fixture.cacheDirectory,
    archivePath: fixture.archivePath,
    testMode: true,
    commandRunner: options.commandRunner ?? createCommandRunner()
  });
}

function manifestForArchive(archivePath, archiveSha256 = hashFile(archivePath)) {
  const manifest = structuredClone(baseManifest);
  const target = manifest.targets[targetTriple];
  target.archiveSha256 = archiveSha256;
  target.trust.certificateSha256 = certificateSha256;
  target.trust.entitlements = {
    'bin/codex': {
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.cs.allow-unsigned-executable-memory': true
    },
    'bin/codex-code-mode-host': {
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.cs.allow-unsigned-executable-memory': true
    }
  };
  return manifest;
}

function createCommandRunner(options = {}) {
  const signingIdentity = options.signingIdentity
    ?? baseManifest.targets[targetTriple].trust.signingIdentity;
  return async (command, args) => {
    if (args.length === 1 && args[0] === '--version') {
      return {
        status: 0,
        stdout: `codex-cli ${baseManifest.codexVersion}\n`,
        stderr: ''
      };
    }
    if (command !== 'codesign') {
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    }
    const certificateArgument = args.find(argument =>
      argument.startsWith('--extract-certificates=')
    );
    if (certificateArgument !== undefined) {
      const prefix = certificateArgument.slice(
        '--extract-certificates='.length
      );
      writeFileSync(`${prefix}0`, certificate);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.includes('--verify')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    const path = args.at(-1);
    const relativePath = executableFiles.find(candidate =>
      path.endsWith(candidate)
    );
    const entitlements = relativePath?.startsWith('bin/')
      ? '<key>com.apple.security.cs.allow-jit</key><true/>'
        + '<key>com.apple.security.cs.allow-unsigned-executable-memory</key>'
        + '<true/>'
      : '';
    return {
      status: 0,
      stdout: '',
      stderr:
        `Authority=${signingIdentity}\n`
        + `TeamIdentifier=${baseManifest.targets[targetTriple].trust.teamIdentifier}\n`
        + (
          entitlements.length === 0
            ? ''
            : `<plist><dict>${entitlements}</dict></plist>\n`
        )
    };
  };
}

function writeFixtureFile(root, relativePath, contents, mode) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

function machoBinary(arch) {
  const contents = Buffer.alloc(64);
  contents.writeUInt32BE(0xcffaedfe, 0);
  contents.writeUInt32LE(
    arch === 'arm64' ? 0x0100000c : 0x01000007,
    4
  );
  return contents;
}

function listFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

function hashFile(path) {
  return hashBuffer(readFileSync(path));
}

function hashBuffer(contents) {
  return createHash('sha256').update(contents).digest('hex');
}
