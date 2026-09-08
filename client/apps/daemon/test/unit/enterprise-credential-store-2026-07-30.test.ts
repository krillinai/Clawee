import { describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseCredentialStore
} from '../../src/enterprise/credential-store-2026-07-30.js';
import type {
  PrivateCredentialFileStore
} from '../../src/security/private-credential-file.js';

describe('enterprise credential store', () => {
  it('reads writes and deletes a validated enterprise credential section', async () => {
    const file = memoryFileStore();
    const store = createEnterpriseCredentialStore({ file });
    const credential = {
      accessToken: 'credential-token',
      expiresAt: '2026-08-27T12:00:00.000Z'
    };

    expect(await store.read()).toBeUndefined();
    await store.write(credential);
    expect(await store.read()).toEqual(credential);
    await store.delete();
    expect(await store.read()).toBeUndefined();
  });

  it('deletes malformed enterprise content without exposing it', async () => {
    const token = 'malformed-enterprise-token';
    const file = memoryFileStore({
      enterprise: { accessToken: token }
    });
    const store = createEnterpriseCredentialStore({ file });

    try {
      await store.read();
      throw new Error('expected malformed enterprise credential to fail');
    } catch (error) {
      expect(String(error)).toContain(
        'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE'
      );
      expect(String(error)).not.toContain(token);
    }
    expect(file.delete).toHaveBeenCalledWith('enterprise');
  });

  it('wraps file failures without exposing submitted credentials', async () => {
    const token = 'enterprise-write-secret';
    const file = memoryFileStore();
    file.write = vi.fn(async () => {
      throw new Error(`failed to persist ${token}`);
    });
    const store = createEnterpriseCredentialStore({ file });

    try {
      await store.write({
        accessToken: token,
        expiresAt: '2026-08-27T12:00:00.000Z'
      });
      throw new Error('expected enterprise credential write to fail');
    } catch (error) {
      expect(String(error)).toContain(
        'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE'
      );
      expect(String(error)).not.toContain(token);
    }
  });
});

function memoryFileStore(initial: {
  enterprise?: unknown;
  modelService?: unknown;
} = {}): PrivateCredentialFileStore & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    read: vi.fn(async section => values.get(section)),
    write: vi.fn(async (section, value) => {
      values.set(section, structuredClone(value));
    }),
    delete: vi.fn(async section => {
      values.delete(section);
    })
  };
}
