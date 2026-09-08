import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  rebaseLegacyCodexRolloutPaths
} from '../../src/codex/runtime-home-state.js';

let tempDir = '';

afterEach(() => {
  if (tempDir.length > 0) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Codex Runtime Home state', () => {
  it('rebases persisted rollout paths from a versioned Home', () => {
    const setup = createSetup();
    const oldPath = join(
      setup.dataDir,
      'codex',
      'homes',
      'codex-rust-v0.151.0-layout-1-server',
      setup.rolloutRelativePath
    );
    insertThread(setup.databasePath, 'thread-1', oldPath);

    expect(rebaseLegacyCodexRolloutPaths({
      dataDir: setup.dataDir,
      stableHome: setup.stableHome
    })).toEqual({
      databasesInspected: 1,
      pathsRebased: 1
    });

    expect(readRolloutPath(setup.databasePath, 'thread-1'))
      .toBe(setup.stableRolloutPath);
  });

  it('fails before legacy Homes are removed when the stable rollout is missing', () => {
    const setup = createSetup({ writeStableRollout: false });
    const legacyHome = join(
      setup.dataDir,
      'codex',
      'homes',
      'codex-rust-v0.151.0-layout-1-server'
    );
    const oldPath = join(legacyHome, setup.rolloutRelativePath);
    mkdirSync(dirname(oldPath), { recursive: true });
    writeFileSync(oldPath, '{}\n');
    insertThread(setup.databasePath, 'thread-1', oldPath);

    expect(() => rebaseLegacyCodexRolloutPaths({
      dataDir: setup.dataDir,
      stableHome: setup.stableHome
    })).toThrow('CODEX_RUNTIME_HOME_REBASE_TARGET_MISSING');

    expect(existsSync(legacyHome)).toBe(true);
    expect(readRolloutPath(setup.databasePath, 'thread-1')).toBe(oldPath);
  });

  it('leaves external rollout paths unchanged', () => {
    const setup = createSetup();
    const externalPath = join(tempDir, 'external', 'rollout.jsonl');
    mkdirSync(dirname(externalPath), { recursive: true });
    writeFileSync(externalPath, '{}\n');
    insertThread(setup.databasePath, 'thread-1', externalPath);

    expect(rebaseLegacyCodexRolloutPaths({
      dataDir: setup.dataDir,
      stableHome: setup.stableHome
    })).toEqual({
      databasesInspected: 1,
      pathsRebased: 0
    });

    expect(readRolloutPath(setup.databasePath, 'thread-1')).toBe(externalPath);
  });
});

function createSetup(input: {
  writeStableRollout?: boolean;
} = {}): {
  dataDir: string;
  stableHome: string;
  databasePath: string;
  rolloutRelativePath: string;
  stableRolloutPath: string;
} {
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-home-state-'));
  const dataDir = join(tempDir, 'data');
  const stableHome = join(dataDir, 'codex-home');
  const databasePath = join(stableHome, 'state_5.sqlite');
  const rolloutRelativePath = join(
    'sessions',
    '2026',
    '09',
    '02',
    'rollout-thread-1.jsonl'
  );
  const stableRolloutPath = join(stableHome, rolloutRelativePath);
  mkdirSync(stableHome, { recursive: true });
  if (input.writeStableRollout !== false) {
    mkdirSync(dirname(stableRolloutPath), { recursive: true });
    writeFileSync(stableRolloutPath, '{}\n');
  }
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL
    )
  `);
  database.close();
  return {
    dataDir,
    stableHome,
    databasePath,
    rolloutRelativePath,
    stableRolloutPath
  };
}

function insertThread(
  databasePath: string,
  id: string,
  rolloutPath: string
): void {
  const database = new Database(databasePath);
  database.prepare(`
    INSERT INTO threads (id, rollout_path)
    VALUES (?, ?)
  `).run(id, rolloutPath);
  database.close();
}

function readRolloutPath(databasePath: string, id: string): string {
  const database = new Database(databasePath, { readonly: true });
  try {
    return (database.prepare(`
      SELECT rollout_path AS rolloutPath
      FROM threads
      WHERE id = ?
    `).get(id) as { rolloutPath: string }).rolloutPath;
  } finally {
    database.close();
  }
}
