import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  assertFormalReleasePlatform,
  assertWindowsSigningConfigured,
  codexRuntimeTargetTriple,
  desktopReleaseTag,
  installerExtension,
  normalizeDesktopPlatform,
  resolveDesktopBuildManifestPath,
  windowsPowerShellEnvironment,
  windowsSignatureVerificationCommand
} from '../scripts/release-platform.mjs';

describe('Desktop release platform', () => {
  it('normalizes GitHub Actions platform names', () => {
    expect(normalizeDesktopPlatform('mac')).toBe('darwin');
    expect(normalizeDesktopPlatform('win')).toBe('win32');
    expect(normalizeDesktopPlatform('linux')).toBe('linux');
  });

  it('maps every supported Desktop platform and architecture to Codex', () => {
    expect(codexRuntimeTargetTriple('darwin', 'arm64'))
      .toBe('aarch64-apple-darwin');
    expect(codexRuntimeTargetTriple('darwin', 'x64'))
      .toBe('x86_64-apple-darwin');
    expect(codexRuntimeTargetTriple('win32', 'arm64'))
      .toBe('aarch64-pc-windows-msvc');
    expect(codexRuntimeTargetTriple('win32', 'x64'))
      .toBe('x86_64-pc-windows-msvc');
    expect(codexRuntimeTargetTriple('linux', 'arm64'))
      .toBe('aarch64-unknown-linux-musl');
    expect(codexRuntimeTargetTriple('linux', 'x64'))
      .toBe('x86_64-unknown-linux-musl');
    expect(() => codexRuntimeTargetTriple('darwin', 'ia32')).toThrow(
      'Unsupported Codex Runtime target'
    );
  });

  it('selects native installer extensions', () => {
    expect(installerExtension('darwin')).toBe('.dmg');
    expect(installerExtension('win32')).toBe('.exe');
    expect(() => installerExtension('linux')).toThrow(
      'Unsupported Desktop artifact platform'
    );
  });

  it('allows formal macOS and Windows releases only', () => {
    expect(() => assertFormalReleasePlatform('darwin')).not.toThrow();
    expect(() => assertFormalReleasePlatform('win32')).not.toThrow();
    expect(() => assertFormalReleasePlatform('linux')).toThrow(
      'Formal Desktop releases do not support linux'
    );
  });

  it('uses semantic version tags without a product-specific prefix', () => {
    expect(desktopReleaseTag('1.0.0')).toBe('v1.0.0');
  });

  it('resolves configured build manifests from the repository root', () => {
    const rootDir = '/repo';
    const releaseDir = '/repo/apps/desktop/release';

    expect(resolveDesktopBuildManifestPath(
      rootDir,
      releaseDir,
      'apps/desktop/release/manifest.json'
    )).toBe(resolve('/repo/apps/desktop/release/manifest.json'));
    expect(resolveDesktopBuildManifestPath(
      rootDir,
      releaseDir,
      '/tmp/manifest.json'
    )).toBe(resolve('/tmp/manifest.json'));
    expect(resolveDesktopBuildManifestPath(
      rootDir,
      releaseDir,
      undefined
    )).toBe(resolve(
      '/repo/apps/desktop/release/clawee-desktop-build-manifest.json'
    ));
  });

  it('requires an Authenticode certificate for formal Windows releases', () => {
    expect(() => assertWindowsSigningConfigured({})).toThrow(
      'Formal Windows releases require WIN_CSC_LINK or CSC_LINK'
    );
    expect(() => assertWindowsSigningConfigured({
      WIN_CSC_LINK: 'base64-certificate'
    })).not.toThrow();
    expect(() => assertWindowsSigningConfigured({
      CSC_LINK: 'certificate.pfx'
    })).not.toThrow();
  });

  it('escapes PowerShell string literals used for signature verification', () => {
    const command = windowsSignatureVerificationCommand(
      "Clawee's installer",
      "C:\\Release\\Clawee's Setup.exe"
    );

    expect(command).toContain("Clawee''s installer");
    expect(command).toContain("Clawee''s Setup.exe");
    expect(command).toContain("$signature.Status -ne 'Valid'");
  });

  it('does not inherit PowerShell Core module paths in Windows PowerShell', () => {
    expect(windowsPowerShellEnvironment({
      Path: 'C:\\Windows\\System32',
      PSModulePath: 'C:\\Program Files\\PowerShell\\Modules',
      PsMoDuLePaTh: 'C:\\Users\\runner\\Documents\\PowerShell\\Modules',
      CLAWEE_TEST: '1'
    })).toEqual({
      Path: 'C:\\Windows\\System32',
      CLAWEE_TEST: '1'
    });
  });
});
