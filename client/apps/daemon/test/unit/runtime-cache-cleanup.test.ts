import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  removeLegacyCodexRuntimeCaches,
  removeLegacyVersionedCodexHomes
} from '../../src/codex/runtime-cache-cleanup.js';

let tempDir = '';

afterEach(() => {
  if (tempDir.length > 0) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Codex Runtime cache cleanup', () => {
  it('removes every legacy rollback Runtime without touching Runtime state', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-cache-cleanup-'));
    const cacheRoot = join(tempDir, 'codex', 'rollback-runtimes');
    const statePath = join(tempDir, 'codex', 'runtime-state.json');
    mkdirSync(join(cacheRoot, 'runtime-old', 'runtime'), { recursive: true });
    writeFileSync(
      join(cacheRoot, 'runtime-old', 'runtime', 'codex'),
      'old binary'
    );
    writeFileSync(statePath, '{}\n');

    await removeLegacyCodexRuntimeCaches(tempDir);

    expect(existsSync(cacheRoot)).toBe(false);
    expect(existsSync(statePath)).toBe(true);
  });

  it('removes versioned Homes after the stable Home is activated', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-home-cleanup-'));
    const homesRoot = join(tempDir, 'codex', 'homes');
    const stableHome = join(tempDir, 'codex-home');
    const migrationPath = join(tempDir, 'codex', 'migrations', 'migration.jsonl');
    mkdirSync(
      join(homesRoot, 'codex-rust-v0.146.0-layout-1-web-dev'),
      { recursive: true }
    );
    mkdirSync(join(stableHome, '.clawee'), { recursive: true });
    mkdirSync(join(tempDir, 'codex', 'migrations'), { recursive: true });
    writeFileSync(
      join(stableHome, '.clawee', 'runtime-home-layout-1'),
      'managed-by-clawee\n'
    );
    writeFileSync(migrationPath, '{}\n');

    await expect(removeLegacyVersionedCodexHomes({
      dataDir: tempDir,
      stableHome,
      layoutVersion: 1
    })).resolves.toBe(true);

    expect(existsSync(homesRoot)).toBe(false);
    expect(existsSync(stableHome)).toBe(true);
    expect(existsSync(migrationPath)).toBe(true);
  });

  it('preserves versioned Homes until the stable Home is activated', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-home-cleanup-'));
    const homesRoot = join(tempDir, 'codex', 'homes');
    const stableHome = join(tempDir, 'codex-home');
    mkdirSync(
      join(homesRoot, 'codex-rust-v0.146.0-layout-1-web-dev'),
      { recursive: true }
    );
    mkdirSync(stableHome, { recursive: true });

    await expect(removeLegacyVersionedCodexHomes({
      dataDir: tempDir,
      stableHome,
      layoutVersion: 1
    })).resolves.toBe(false);

    expect(existsSync(homesRoot)).toBe(true);
  });
});
