import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createPrivateCredentialFileStore,
  PrivateCredentialFileError,
  resolvePrivateCredentialFilePath
} from '../../src/security/private-credential-file.js';

describe('private credential file', () => {
  it('atomically preserves concurrent enterprise and model credential writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-private-credential-'));
    const path = resolvePrivateCredentialFilePath({ dataDir: root });
    const store = createPrivateCredentialFileStore({ path });
    const enterprise = {
      accessToken: 'enterprise-token',
      expiresAt: '2026-08-27T12:00:00.000Z'
    };
    const modelService = { apiKey: 'model-api-key' };

    try {
      await Promise.all([
        store.write('enterprise', enterprise),
        store.write('modelService', modelService)
      ]);

      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        schemaVersion: 1,
        enterprise,
        modelService
      });
      expect(await store.read('enterprise')).toEqual(enterprise);
      expect(await store.read('modelService')).toEqual(modelService);
      if (process.platform !== 'win32') {
        expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }

      await store.delete('enterprise');
      expect(await store.read('modelService')).toEqual(modelService);
      await store.delete('modelService');
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for unknown schemas and symbolic-link destinations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-private-credential-'));
    const path = resolvePrivateCredentialFilePath({ dataDir: root });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      unexpected: 'secret'
    }), { mode: 0o600 });

    try {
      const store = createPrivateCredentialFileStore({ path });
      await expect(store.read('enterprise')).rejects.toBeInstanceOf(
        PrivateCredentialFileError
      );

      if (process.platform !== 'win32') {
        rmSync(path);
        const target = join(root, 'target.json');
        writeFileSync(target, '{"schemaVersion":1}', { mode: 0o600 });
        symlinkSync(target, path);
        await expect(store.read('enterprise')).rejects.toBeInstanceOf(
          PrivateCredentialFileError
        );

        rmSync(dirname(path), { recursive: true, force: true });
        const targetDirectory = join(root, 'target-directory');
        mkdirSync(targetDirectory);
        symlinkSync(targetDirectory, dirname(path));
        await expect(
          store.write('modelService', { apiKey: 'must-not-be-written' })
        ).rejects.toBeInstanceOf(PrivateCredentialFileError);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies Windows DACL hardening to the private directory and file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-private-credential-'));
    const path = resolvePrivateCredentialFilePath({ dataDir: root });
    const hardenWindowsPath = vi.fn(async () => undefined);
    const store = createPrivateCredentialFileStore({
      path,
      platform: 'win32',
      hardenWindowsPath
    });

    try {
      await store.write('modelService', { apiKey: 'windows-key' });
      expect(hardenWindowsPath).toHaveBeenCalledWith(
        dirname(path),
        'directory'
      );
      expect(hardenWindowsPath).toHaveBeenCalledWith(
        path,
        'file'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses a constrained isolated filename for packaged E2E', () => {
    const runId = '123e4567-e89b-42d3-a456-426614174000';
    expect(resolvePrivateCredentialFilePath({
      dataDir: '/tmp/clawee',
      e2eRunId: runId
    })).toContain(`credentials-e2e-${runId}.json`);
    expect(() => resolvePrivateCredentialFilePath({
      dataDir: '/tmp/clawee',
      e2eRunId: '../escape'
    })).toThrow('ENTERPRISE_E2E_CONFIG_FORBIDDEN');
  });
});
