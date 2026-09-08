import { describe, expect, it, vi } from 'vitest';
import {
  createModelServiceCredentialStore
} from '../../src/codex/model-service-credential-store.js';
import type {
  PrivateCredentialFileStore
} from '../../src/security/private-credential-file.js';

describe('model service credential store', () => {
  it('reads writes and deletes only the model API key section', async () => {
    const file = memoryFileStore();
    const store = createModelServiceCredentialStore({ file });

    expect(await store.read()).toBeUndefined();
    await store.write('secret-key');
    expect(await store.read()).toBe('secret-key');
    expect(file.write).toHaveBeenCalledWith('modelService', {
      apiKey: 'secret-key'
    });
    await store.delete();
    expect(await store.read()).toBeUndefined();
  });

  it('rejects malformed stored or submitted API keys without exposing them', async () => {
    const stored = ' malformed-model-key ';
    const file = memoryFileStore({
      modelService: { apiKey: stored }
    });
    const store = createModelServiceCredentialStore({ file });

    try {
      await store.read();
      throw new Error('expected malformed model credential to fail');
    } catch (error) {
      expect(String(error)).toContain(
        'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE'
      );
      expect(String(error)).not.toContain(stored);
    }
    expect(file.delete).toHaveBeenCalledWith('modelService');

    await expect(store.write(' invalid ')).rejects.toThrow(
      'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE'
    );
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
