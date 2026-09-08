import type {
  PrivateCredentialFileStore
} from '../security/private-credential-file.js';

const MAX_API_KEY_BYTES = 64 * 1024;

export type ModelServiceCredentialStore = {
  read(): Promise<string | undefined>;
  write(apiKey: string): Promise<void>;
  delete(): Promise<void>;
};

export class ModelServiceCredentialStoreError extends Error {
  readonly code = 'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE';

  constructor(stage: 'read' | 'write' | 'delete') {
    super(
      `MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE: model service API key ${stage} failed`
    );
    this.name = 'ModelServiceCredentialStoreError';
  }
}

export function createModelServiceCredentialStore(input: {
  file: PrivateCredentialFileStore;
}): ModelServiceCredentialStore {
  return {
    async read() {
      let value: unknown;
      try {
        value = await input.file.read('modelService');
      } catch {
        throw new ModelServiceCredentialStoreError('read');
      }
      if (value === undefined) return undefined;
      try {
        return validateStoredApiKey(value);
      } catch {
        await input.file.delete('modelService').catch(() => undefined);
        throw new ModelServiceCredentialStoreError('read');
      }
    },
    async write(apiKey) {
      let value: string;
      try {
        value = validateApiKey(apiKey);
      } catch {
        throw new ModelServiceCredentialStoreError('write');
      }
      try {
        await input.file.write('modelService', { apiKey: value });
      } catch {
        throw new ModelServiceCredentialStoreError('write');
      }
    },
    async delete() {
      try {
        await input.file.delete('modelService');
      } catch {
        throw new ModelServiceCredentialStoreError('delete');
      }
    }
  };
}

function validateStoredApiKey(value: unknown): string {
  if (
    !isRecord(value)
    || Object.keys(value).length !== 1
    || typeof value.apiKey !== 'string'
  ) {
    throw new Error('invalid API key');
  }
  return validateApiKey(value.apiKey);
}

function validateApiKey(value: string): string {
  if (
    value.length === 0
    || value.trim() !== value
    || value.includes('\0')
    || Buffer.byteLength(value) > MAX_API_KEY_BYTES
  ) {
    throw new Error('invalid API key');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
