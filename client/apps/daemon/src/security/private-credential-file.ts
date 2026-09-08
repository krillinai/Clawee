import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const execFileAsync = promisify(execFile);

export const PRIVATE_CREDENTIAL_DIRECTORY_NAME = 'private';
export const PRIVATE_CREDENTIAL_FILE_NAME = 'credentials.json';

export type PrivateCredentialSection = 'enterprise' | 'modelService';

export type PrivateCredentialFileStore = {
  read(section: PrivateCredentialSection): Promise<unknown | undefined>;
  write(section: PrivateCredentialSection, value: unknown): Promise<void>;
  delete(section: PrivateCredentialSection): Promise<void>;
};

export type PrivateCredentialPathKind = 'directory' | 'file';

type PrivateCredentialDocument = {
  schemaVersion: 1;
  enterprise?: unknown;
  modelService?: unknown;
};

export class PrivateCredentialFileError extends Error {
  readonly code = 'PRIVATE_CREDENTIAL_FILE_UNAVAILABLE';

  constructor(stage: 'read' | 'write' | 'delete') {
    super(`PRIVATE_CREDENTIAL_FILE_UNAVAILABLE: ${stage} failed`);
    this.name = 'PrivateCredentialFileError';
  }
}

export function resolvePrivateCredentialFilePath(input: {
  dataDir: string;
  e2eRunId?: string;
}): string {
  const directory = join(
    resolve(input.dataDir),
    PRIVATE_CREDENTIAL_DIRECTORY_NAME
  );
  if (input.e2eRunId === undefined) {
    return join(directory, PRIVATE_CREDENTIAL_FILE_NAME);
  }
  if (!UUID_PATTERN.test(input.e2eRunId)) {
    throw new Error('ENTERPRISE_E2E_CONFIG_FORBIDDEN');
  }
  return join(directory, `credentials-e2e-${input.e2eRunId}.json`);
}

export function createPrivateCredentialFileStore(input: {
  path: string;
  platform?: NodeJS.Platform;
  hardenWindowsPath?(
    path: string,
    kind: PrivateCredentialPathKind
  ): Promise<void>;
}): PrivateCredentialFileStore {
  const path = resolve(input.path);
  const platform = input.platform ?? process.platform;
  const hardenWindowsPath =
    input.hardenWindowsPath ?? restrictWindowsPathToCurrentUser;
  let pending: Promise<void> = Promise.resolve();

  function enqueue<Result>(
    stage: 'read' | 'write' | 'delete',
    operation: () => Promise<Result>
  ): Promise<Result> {
    const result = pending.then(operation, operation);
    pending = result.then(() => undefined, () => undefined);
    return result.catch(() => {
      throw new PrivateCredentialFileError(stage);
    });
  }

  async function harden(
    targetPath: string,
    kind: PrivateCredentialPathKind
  ): Promise<void> {
    if (platform === 'win32') {
      await hardenWindowsPath(targetPath, kind);
      return;
    }
    await chmod(targetPath, kind === 'directory' ? 0o700 : 0o600);
  }

  async function readDocument():
  Promise<PrivateCredentialDocument | undefined> {
    const directory = dirname(path);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
      throw new Error('private credential path is invalid');
    }
    await assertSafeDirectory(directory);
    await harden(directory, 'directory');
    await harden(path, 'file');
    const source = await readFile(path, 'utf8');
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) {
      throw new Error('private credential file is too large');
    }
    return parseDocument(source);
  }

  async function writeDocument(
    document: PrivateCredentialDocument
  ): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertSafeDirectory(directory);
    await harden(directory, 'directory');

    if (!hasCredentialSections(document)) {
      await assertSafeDestination(path);
      await rm(path, { force: true });
      return;
    }

    const contents = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES) {
      throw new Error('private credential file is too large');
    }
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, contents, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      });
      await harden(temporaryPath, 'file');
      await assertSafeDestination(path);
      await rename(temporaryPath, path);
      await harden(path, 'file');
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return {
    read(section) {
      return enqueue('read', async () => {
        const document = await readDocument();
        const value = document?.[section];
        return value === undefined ? undefined : structuredClone(value);
      });
    },
    write(section, value) {
      return enqueue('write', async () => {
        if (value === undefined) {
          throw new Error('private credential value is invalid');
        }
        const current = await readDocument() ?? emptyDocument();
        await writeDocument({
          ...current,
          [section]: structuredClone(value)
        });
      });
    },
    delete(section) {
      return enqueue('delete', async () => {
        const current = await readDocument();
        if (current === undefined || current[section] === undefined) return;
        const next = { ...current };
        delete next[section];
        await writeDocument(next);
      });
    }
  };
}

function emptyDocument(): PrivateCredentialDocument {
  return { schemaVersion: SCHEMA_VERSION };
}

function parseDocument(source: string): PrivateCredentialDocument {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('private credential file is invalid');
  }
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('private credential file is invalid');
  }
  const allowedKeys = new Set([
    'schemaVersion',
    'enterprise',
    'modelService'
  ]);
  if (Object.keys(value).some(key => !allowedKeys.has(key))) {
    throw new Error('private credential file is invalid');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    ...('enterprise' in value
      ? { enterprise: structuredClone(value.enterprise) }
      : {}),
    ...('modelService' in value
      ? { modelService: structuredClone(value.modelService) }
      : {})
  };
}

function hasCredentialSections(
  document: PrivateCredentialDocument
): boolean {
  return (
    document.enterprise !== undefined
    || document.modelService !== undefined
  );
}

async function assertSafeDestination(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('private credential path is invalid');
    }
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function assertSafeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('private credential directory is invalid');
  }
}

let currentWindowsUserSid: Promise<string> | undefined;

async function restrictWindowsPathToCurrentUser(
  path: string,
  kind: PrivateCredentialPathKind
): Promise<void> {
  currentWindowsUserSid ??= resolveCurrentWindowsUserSid();
  const sid = await currentWindowsUserSid;
  const grant = kind === 'directory'
    ? `*${sid}:(OI)(CI)F`
    : `*${sid}:F`;
  await execFileAsync('icacls.exe', [
    path,
    '/inheritance:r',
    '/grant:r',
    grant
  ], {
    encoding: 'utf8',
    windowsHide: true
  });
}

async function resolveCurrentWindowsUserSid(): Promise<string> {
  const result = await execFileAsync('whoami.exe', [
    '/user',
    '/fo',
    'csv',
    '/nh'
  ], {
    encoding: 'utf8',
    windowsHide: true
  });
  const match = result.stdout.match(/S-\d+(?:-\d+)+/i);
  if (match === null) {
    throw new Error('current Windows user SID is unavailable');
  }
  return match[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT'
  );
}
