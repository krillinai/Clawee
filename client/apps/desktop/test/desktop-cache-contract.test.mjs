import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureElectronBuilderCacheScope
} from '../scripts/desktop-cache-contract.mjs';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Desktop cache contract', () => {
  it('isolates downloaded CommonJS tools from an ESM parent package', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-builder-cache-'));
    tempRoots.push(root);
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ type: 'module' })}\n`
    );
    const cacheRoot = join(root, 'apps', 'desktop', '.cache', 'electron-builder');
    mkdirSync(dirname(cacheRoot), { recursive: true });

    const result = ensureElectronBuilderCacheScope(cacheRoot);

    expect(result.cacheRoot).toBe(cacheRoot);
    expect(JSON.parse(readFileSync(result.packagePath, 'utf8'))).toEqual({
      private: true,
      type: 'commonjs'
    });
  });

  it('repairs a stale cache package scope before packaging', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-builder-cache-'));
    tempRoots.push(root);
    const cacheRoot = join(root, 'electron-builder');
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(
      join(cacheRoot, 'package.json'),
      `${JSON.stringify({ type: 'module' })}\n`
    );

    ensureElectronBuilderCacheScope(cacheRoot);

    expect(
      JSON.parse(readFileSync(join(cacheRoot, 'package.json'), 'utf8')).type
    ).toBe('commonjs');
  });
});
