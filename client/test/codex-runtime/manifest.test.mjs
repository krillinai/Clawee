import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readCodexRuntimeManifest,
  resolveCodexRuntimeTarget
} from '../../scripts/codex-runtime/manifest.mjs';

const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const SHA256_C = 'c'.repeat(64);

test('rejects_placeholder_hashes_and_formal_targets_without_trust_identity', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-manifest-'));
  const manifestPath = join(tempDir, 'codex-runtime.json');
  const manifest = validManifest();
  manifest.releaseTag = 'latest';
  manifest.schemas.stable.sha256 = '';
  manifest.targets['aarch64-apple-darwin'].trust.signingIdentity = '*';
  delete manifest.targets['x86_64-pc-windows-msvc'].trust.certificateSha256;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  try {
    assert.throws(
      () => readCodexRuntimeManifest(manifestPath),
      error => {
        assert.deepEqual(
          error.issues.map(issue => issue.code),
          [
            'MANIFEST_RELEASE_TAG_INVALID',
            'MANIFEST_SCHEMA_HASH_INVALID',
            'MANIFEST_TRUST_IDENTITY_INVALID',
            'MANIFEST_TRUST_IDENTITY_MISSING'
          ]
        );
        return true;
      }
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test('resolves_one_exact_target_and_rejects_duplicate_platform_arch_pairs', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-manifest-'));
  const manifestPath = join(tempDir, 'codex-runtime.json');

  try {
    writeFileSync(manifestPath, `${JSON.stringify(validManifest(), null, 2)}\n`);
    const manifest = readCodexRuntimeManifest(manifestPath);
    assert.equal(
      resolveCodexRuntimeTarget(manifest, {
        platform: 'darwin',
        arch: 'arm64'
      }).targetTriple,
      'aarch64-apple-darwin'
    );

    const duplicate = validManifest();
    duplicate.targets['duplicate-darwin-arm64'] = {
      ...duplicate.targets['aarch64-apple-darwin'],
      targetTriple: 'duplicate-darwin-arm64',
      assetName: 'codex-package-duplicate-darwin-arm64.tar.gz'
    };
    writeFileSync(manifestPath, `${JSON.stringify(duplicate, null, 2)}\n`);
    assert.throws(
      () => readCodexRuntimeManifest(manifestPath),
      error => {
        assert.deepEqual(
          error.issues.map(issue => issue.code),
          ['MANIFEST_TARGET_DUPLICATE']
        );
        return true;
      }
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function validManifest() {
  return {
    schemaVersion: 1,
    runtimeId: 'codex-rust-v0.146.0-layout-1',
    codexVersion: '0.146.0',
    releaseTag: 'rust-v0.146.0',
    sourceCommit: SHA256_A.slice(0, 40),
    variant: 'codex',
    layoutVersion: 1,
    minimumClaweeVersion: '1.0.0',
    previousSupportedReleaseTag: 'rust-v0.146.0',
    schemas: {
      stable: {
        path: 'config/codex-app-server-schema/rust-v0.146.0/stable.json',
        sha256: SHA256_A
      },
      experimental: {
        path: 'config/codex-app-server-schema/rust-v0.146.0/experimental.json',
        sha256: SHA256_B
      }
    },
    targets: {
      'aarch64-apple-darwin': {
        platform: 'darwin',
        arch: 'arm64',
        targetTriple: 'aarch64-apple-darwin',
        assetName: 'codex-package-aarch64-apple-darwin.tar.gz',
        archiveSha256: SHA256_A,
        expectedFiles: [
          'bin/codex',
          'bin/codex-code-mode-host',
          'codex-path/rg',
          'codex-resources/zsh/bin/zsh',
          'codex-package.json'
        ],
        trust: {
          kind: 'apple-code-signing',
          signingIdentity: 'Developer ID Application: OpenAI, L.L.C.',
          teamIdentifier: '2DC432GLL2',
          certificateSha256: SHA256_C,
          signedFiles: [
            'bin/codex',
            'bin/codex-code-mode-host',
            'codex-path/rg',
            'codex-resources/zsh/bin/zsh'
          ],
          entitlements: {
            'bin/codex': {
              'com.apple.security.cs.allow-jit': true
            }
          }
        },
        formalRelease: true
      },
      'x86_64-pc-windows-msvc': {
        platform: 'win32',
        arch: 'x64',
        targetTriple: 'x86_64-pc-windows-msvc',
        assetName: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
        archiveSha256: SHA256_B,
        expectedFiles: [
          'bin/codex.exe',
          'bin/codex-code-mode-host.exe',
          'codex-resources/codex-command-runner.exe',
          'codex-resources/codex-windows-sandbox-setup.exe',
          'codex-path/rg.exe',
          'codex-package.json'
        ],
        trust: {
          kind: 'authenticode',
          subject: 'OpenAI, L.L.C.',
          certificateSha256: SHA256_C,
          signedFiles: [
            'bin/codex.exe',
            'bin/codex-code-mode-host.exe',
            'codex-resources/codex-command-runner.exe',
            'codex-resources/codex-windows-sandbox-setup.exe'
          ],
          unsignedFiles: {
            'codex-path/rg.exe': SHA256_A
          }
        },
        formalRelease: true
      }
    }
  };
}
