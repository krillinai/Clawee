import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertCodexRuntimePackage
} from '../scripts/codex-runtime-package-contract.mjs';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Codex Runtime package contract', () => {
  it('package_manifest_records_embedded_codex_runtime_and_verify_rejects_drift', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-runtime-package-'));
    tempRoots.push(root);
    const sourceDirectory = join(root, 'source');
    const packagedDirectory = join(root, 'packaged');
    writeFile(sourceDirectory, 'bin/codex', 'codex', 0o755);
    writeFile(sourceDirectory, 'bin/codex-code-mode-host', 'host', 0o755);
    writeFile(sourceDirectory, 'codex-path/rg', 'rg', 0o755);
    writeFile(sourceDirectory, 'codex-resources/zsh/bin/zsh', 'zsh', 0o755);
    writeFile(
      sourceDirectory,
      'codex-package.json',
      `${JSON.stringify({
        layoutVersion: 1,
        version: '0.146.0',
        target: 'aarch64-apple-darwin',
        variant: 'codex',
        entrypoint: 'bin/codex',
        resourcesDir: 'codex-resources',
        pathDir: 'codex-path'
      })}\n`,
      0o644
    );
    cpSync(sourceDirectory, packagedDirectory, {
      recursive: true,
      preserveTimestamps: true
    });

    const source = inspectDirectory(sourceDirectory);
    const buildManifest = {
      version: 2,
      codexRuntimeId: 'codex-rust-v0.146.0-layout-1',
      codexRuntimeVersion: '0.146.0',
      codexRuntimeReleaseTag: 'rust-v0.146.0',
      codexRuntimeTarget: 'aarch64-apple-darwin',
      codexRuntimeLayoutVersion: 1,
      codexRuntimeEntrypoint: 'bin/codex',
      codexRuntimeFileCount: source.fileCount,
      codexRuntimeContentSha256: source.hash,
      codexRuntimeArchiveSha256: 'a'.repeat(64)
    };
    const runtimeManifest = {
      runtimeId: buildManifest.codexRuntimeId,
      codexVersion: buildManifest.codexRuntimeVersion,
      releaseTag: buildManifest.codexRuntimeReleaseTag,
      layoutVersion: buildManifest.codexRuntimeLayoutVersion
    };
    const target = {
      targetTriple: buildManifest.codexRuntimeTarget,
      archiveSha256: buildManifest.codexRuntimeArchiveSha256
    };

    await expect(assertCodexRuntimePackage({
      sourceDirectory,
      packagedDirectory,
      buildManifest,
      runtimeManifest,
      target,
      platform: 'darwin'
    })).resolves.toMatchObject({
      contentSha256: source.hash,
      fileCount: source.fileCount
    });

    writeFileSync(join(packagedDirectory, 'codex-path/rg'), 'tampered');
    await expect(assertCodexRuntimePackage({
      sourceDirectory,
      packagedDirectory,
      buildManifest,
      runtimeManifest,
      target,
      platform: 'darwin'
    })).rejects.toThrow(/codex-path\/rg.*content/i);
  });
});

function writeFile(root, relativePath, contents, mode) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

function inspectDirectory(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...inspectDirectory(root, path).files);
    } else if (entry.isFile()) {
      files.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  files.sort();
  const aggregate = createHash('sha256');
  for (const path of files) {
    const digest = createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex');
    aggregate.update(path).update('\0').update(digest).update('\0');
  }
  return {
    files,
    fileCount: files.length,
    hash: aggregate.digest('hex')
  };
}
