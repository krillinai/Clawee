import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRuntimeToken } from './token.js';

export function loadOrCreateServerToken(inputPath: string): string {
  const path = resolve(inputPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  try {
    return readServerToken(path);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }

  const token = createRuntimeToken();
  try {
    writeFileSync(path, `${token}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return readServerToken(path);
  }
  chmodSync(path, 0o600);
  return token;
}

export function resolveServerToken(input: {
  tokenSource: 'config' | 'file';
  token?: string;
  tokenFile?: string;
}): string {
  if (input.tokenSource === 'config') {
    const token = input.token?.trim();
    if (token === undefined || token.length === 0) {
      throw new Error('SERVER_CONFIG_TOKEN_INVALID');
    }
    return token;
  }
  if (input.tokenFile === undefined) {
    throw new Error('SERVER_CONFIG_TOKEN_INVALID');
  }
  return loadOrCreateServerToken(input.tokenFile);
}

function readServerToken(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) {
    throw new Error('SERVER_TOKEN_FILE_INVALID');
  }
  chmodSync(path, 0o600);
  const token = readFileSync(path, 'utf8').trim();
  if (token.length === 0) throw new Error('SERVER_TOKEN_FILE_INVALID');
  return token;
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}
