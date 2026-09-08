import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadOrCreateServerToken,
  resolveServerToken
} from '../../src/security/server-token.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('server token', () => {
  it('returns a direct token without accessing the configured token file', () => {
    expect(resolveServerToken({
      tokenSource: 'config',
      token: ' direct-token ',
      tokenFile: '/path/that/does/not/exist'
    })).toBe('direct-token');
  });

  it('rejects an explicitly blank direct token', () => {
    expect(() => resolveServerToken({
      tokenSource: 'config',
      token: '   ',
      tokenFile: '/unused'
    })).toThrow('SERVER_CONFIG_TOKEN_INVALID');
  });

  it('creates a private token file and reuses it across startups', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-server-token-'));
    const path = join(tempDir, 'state', 'server-token');

    const first = loadOrCreateServerToken(path);
    const second = loadOrCreateServerToken(path);

    expect(second).toBe(first);
    expect(readFileSync(path, 'utf8').trim()).toBe(first);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });
});
