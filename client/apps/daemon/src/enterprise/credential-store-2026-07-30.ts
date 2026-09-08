import type {
  PrivateCredentialFileStore
} from '../security/private-credential-file.js';

const RFC_3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type EnterpriseCredential = {
  accessToken: string;
  expiresAt: string;
  origin?: string;
};

export type EnterpriseCredentialStore = {
  read(): Promise<EnterpriseCredential | undefined>;
  write(credential: EnterpriseCredential): Promise<void>;
  delete(): Promise<void>;
};

export class EnterpriseCredentialStoreError extends Error {
  readonly code = 'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE';

  constructor(stage: 'read' | 'write' | 'delete' | 'decode') {
    super(`ENTERPRISE_SECURE_STORAGE_UNAVAILABLE: enterprise credential ${stage} failed`);
    this.name = 'EnterpriseCredentialStoreError';
  }
}

export function createEnterpriseCredentialStore(input: {
  file: PrivateCredentialFileStore;
}): EnterpriseCredentialStore {
  return {
    async read() {
      let value: unknown;
      try {
        value = await input.file.read('enterprise');
      } catch {
        throw new EnterpriseCredentialStoreError('read');
      }
      if (value === undefined) return undefined;
      try {
        return validateCredential(value);
      } catch {
        await input.file.delete('enterprise').catch(() => undefined);
        throw new EnterpriseCredentialStoreError('decode');
      }
    },

    async write(credential) {
      let value: EnterpriseCredential;
      try {
        value = validateCredential(credential);
      } catch {
        throw new EnterpriseCredentialStoreError('write');
      }
      try {
        await input.file.write('enterprise', value);
      } catch {
        throw new EnterpriseCredentialStoreError('write');
      }
    },

    async delete() {
      try {
        await input.file.delete('enterprise');
      } catch {
        throw new EnterpriseCredentialStoreError('delete');
      }
    }
  };
}

function validateCredential(value: unknown): EnterpriseCredential {
  if (!isPlainObject(value)) throw new Error('invalid credential');

  const keys = Object.keys(value);
  if (
    (keys.length !== 2 && keys.length !== 3)
    || keys.some(key => !['accessToken', 'expiresAt', 'origin'].includes(key))
    || (value.origin !== undefined && typeof value.origin !== 'string')
    || !keys.includes('accessToken')
    || !keys.includes('expiresAt')
    || typeof value.accessToken !== 'string'
    || value.accessToken.length === 0
    || typeof value.expiresAt !== 'string'
    || !isRfc3339(value.expiresAt)
  ) {
    throw new Error('invalid credential');
  }

  return {
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    ...(typeof value.origin === 'string' ? { origin: value.origin } : {})
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRfc3339(value: string): boolean {
  return RFC_3339_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}
