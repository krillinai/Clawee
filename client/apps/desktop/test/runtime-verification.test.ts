import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  verifyDesktopRuntimeDirectory,
  windowsPowerShellCommand,
  windowsPowerShellEnvironment,
  type CodexRuntimeManifest,
  type CodexRuntimePackageDescriptor
} from '../src/main/runtime-verification.js';

const tempRoots: string[] = [];
const unixIt = process.platform === 'win32' ? it.skip : it;

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Desktop Runtime verification', () => {
  it('removes PowerShell 7 module paths before Authenticode inspection', () => {
    expect(windowsPowerShellEnvironment({
      PATH: 'C:\\Windows\\System32',
      PSModulePath: 'C:\\Program Files\\PowerShell\\Modules',
      psMODULEpath: 'C:\\Users\\runneradmin\\Documents\\PowerShell\\Modules'
    })).toEqual({
      PATH: 'C:\\Windows\\System32'
    });
  });

  it('resolves Windows PowerShell independently from PATH', () => {
    expect(windowsPowerShellCommand({
      PATH: 'C:\\hostile-bin;C:\\Windows\\System32',
      systemROOT: 'C:\\Windows'
    })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    );
    expect(windowsPowerShellCommand({
      windir: 'D:\\Windows'
    })).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    );
    expect(windowsPowerShellCommand({})).toBe('powershell.exe');
  });

  it('uses the system PowerShell path for Authenticode inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-runtime-verification-'));
    tempRoots.push(root);
    const runtimeDirectory = join(root, 'runtime');
    writeFixtureFile(join(runtimeDirectory, 'bin/codex.exe'), 'signed-codex', 0o644);
    writeFixtureFile(
      join(runtimeDirectory, 'codex-package.json'),
      `${JSON.stringify({
        layoutVersion: 1,
        version: '0.146.0',
        target: 'x86_64-pc-windows-msvc',
        variant: 'codex',
        entrypoint: 'bin/codex.exe',
        resourcesDir: 'codex-resources',
        pathDir: 'codex-path'
      })}\n`,
      0o644
    );
    const target = {
      platform: 'win32' as const,
      arch: 'x64' as const,
      targetTriple: 'x86_64-pc-windows-msvc',
      archiveSha256: 'b'.repeat(64),
      expectedFiles: ['bin/codex.exe', 'codex-package.json'],
      trust: {
        kind: 'authenticode' as const,
        signedFiles: ['bin/codex.exe']
      },
      formalRelease: true
    };
    const manifest: CodexRuntimeManifest = {
      ...createManifest(),
      targets: { [target.targetTriple]: target }
    };
    const packageDescriptor: CodexRuntimePackageDescriptor = {
      schemaVersion: 1,
      runtimeId: manifest.runtimeId,
      codexVersion: manifest.codexVersion,
      releaseTag: manifest.releaseTag,
      target: target.targetTriple,
      layoutVersion: manifest.layoutVersion,
      entrypoint: 'bin/codex.exe',
      fileCount: 2,
      contentSha256: hashRuntimeDirectory(runtimeDirectory, [
        'bin/codex.exe',
        'codex-package.json'
      ]),
      archiveSha256: target.archiveSha256
    };
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const commandRunner = vi.fn(async (command: string) => (
      command === join(runtimeDirectory, 'bin/codex.exe')
        ? {
            status: 0,
            stdout: 'codex-cli 0.146.0\n',
            stderr: ''
          }
        : {
            status: 0,
            stdout: 'Valid\n',
            stderr: ''
          }
    ));

    await expect(verifyDesktopRuntimeDirectory({
      directory: runtimeDirectory,
      manifest,
      target,
      packageDescriptor,
      commandRunner
    })).resolves.toMatchObject({
      entrypoint: 'bin/codex.exe'
    });
    expect(commandRunner).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        expect.stringContaining('Get-AuthenticodeSignature')
      ]
    );
  });

  unixIt('accepts the pinned directory and rejects content or signature drift', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-runtime-verification-'));
    tempRoots.push(root);
    const runtimeDirectory = join(root, 'runtime');
    writeFixtureFile(
      join(runtimeDirectory, 'bin/codex'),
      'signed-codex',
      0o755
    );
    writeFixtureFile(
      join(runtimeDirectory, 'codex-package.json'),
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
    const manifest = createManifest();
    const packageDescriptor = createPackageDescriptor(runtimeDirectory);
    const commandRunner = vi.fn(async (
      command: string,
      args: string[]
    ) => command === join(runtimeDirectory, 'bin/codex')
      ? {
          status: 0,
          stdout: 'codex-cli 0.146.0\n',
          stderr: ''
        }
      : {
          status: args[0] === '--verify' ? 0 : 1,
          stdout: '',
          stderr: ''
        });

    await expect(verifyDesktopRuntimeDirectory({
      directory: runtimeDirectory,
      manifest,
      target: manifest.targets['aarch64-apple-darwin']!,
      packageDescriptor,
      commandRunner
    })).resolves.toMatchObject({
      entrypoint: 'bin/codex',
      fileCount: 2,
      contentSha256: packageDescriptor.contentSha256
    });

    writeFileSync(join(runtimeDirectory, 'bin/codex'), 'tampered');
    await expect(verifyDesktopRuntimeDirectory({
      directory: runtimeDirectory,
      manifest,
      target: manifest.targets['aarch64-apple-darwin']!,
      packageDescriptor,
      commandRunner
    })).rejects.toThrow('CODEX_RUNTIME_CONTENT_HASH_MISMATCH');

    writeFileSync(join(runtimeDirectory, 'bin/codex'), 'signed-codex');
    await expect(verifyDesktopRuntimeDirectory({
      directory: runtimeDirectory,
      manifest,
      target: manifest.targets['aarch64-apple-darwin']!,
      packageDescriptor,
      commandRunner: async command => command === join(runtimeDirectory, 'bin/codex')
        ? {
            status: 0,
            stdout: 'codex-cli 0.146.0\n',
            stderr: ''
          }
        : {
            status: 1,
            stdout: '',
            stderr: 'invalid signature'
          }
    })).rejects.toThrow('CODEX_RUNTIME_SIGNATURE_INVALID');
  });
});

function createManifest(): CodexRuntimeManifest {
  return {
    schemaVersion: 1,
    runtimeId: 'codex-rust-v0.146.0-layout-1',
    codexVersion: '0.146.0',
    releaseTag: 'rust-v0.146.0',
    sourceCommit: 'e363b08c9175ac1cbe5893615dd2cb9ddf95043b',
    variant: 'codex',
    layoutVersion: 1,
    minimumClaweeVersion: '1.0.0',
    previousSupportedReleaseTag: 'rust-v0.145.0',
    targets: {
      'aarch64-apple-darwin': {
        platform: 'darwin',
        arch: 'arm64',
        targetTriple: 'aarch64-apple-darwin',
        archiveSha256: 'a'.repeat(64),
        expectedFiles: ['bin/codex', 'codex-package.json'],
        trust: {
          kind: 'apple-code-signing',
          signedFiles: ['bin/codex']
        },
        formalRelease: true
      }
    }
  };
}

function createPackageDescriptor(
  runtimeDirectory: string
): CodexRuntimePackageDescriptor {
  return {
    schemaVersion: 1,
    runtimeId: 'codex-rust-v0.146.0-layout-1',
    codexVersion: '0.146.0',
    releaseTag: 'rust-v0.146.0',
    target: 'aarch64-apple-darwin',
    layoutVersion: 1,
    entrypoint: 'bin/codex',
    fileCount: 2,
    contentSha256: hashRuntimeDirectory(runtimeDirectory),
    archiveSha256: 'a'.repeat(64)
  };
}

function writeFixtureFile(path: string, contents: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

function hashRuntimeDirectory(
  directory: string,
  paths = ['bin/codex', 'codex-package.json']
): string {
  const hash = createHash('sha256');
  for (const path of paths) {
    const digest = createHash('sha256')
      .update(readFileSync(join(directory, path)))
      .digest('hex');
    hash.update(path).update('\0').update(digest).update('\0');
  }
  return hash.digest('hex');
}
