import {
  existsSync,
  readdirSync,
  statSync
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';
import Database from 'better-sqlite3';

type CodexThreadPathRow = {
  id: string;
  rolloutPath: string;
};

export function rebaseLegacyCodexRolloutPaths(input: {
  dataDir: string;
  stableHome: string;
}): {
  databasesInspected: number;
  pathsRebased: number;
} {
  const stableHome = resolve(input.stableHome);
  const legacyRoots = [
    join(resolve(input.dataDir), 'codex', 'homes'),
    join(stableHome, 'homes')
  ];
  let databasesInspected = 0;
  let pathsRebased = 0;

  for (const filename of listCodexStateDatabases(stableHome)) {
    const database = new Database(join(stableHome, filename));
    databasesInspected += 1;
    try {
      const table = database.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'threads'
      `).get();
      if (table === undefined) continue;
      const columns = database.prepare('PRAGMA table_info(threads)').all() as
        Array<{ name: string }>;
      if (!columns.some(column => column.name === 'rollout_path')) continue;

      const rows = database.prepare(`
        SELECT id, rollout_path AS rolloutPath
        FROM threads
      `).all() as CodexThreadPathRow[];
      const updates = rows.flatMap(row => {
        const targetPath = rebaseLegacyRolloutPath(
          row.rolloutPath,
          stableHome,
          legacyRoots
        );
        if (targetPath === null) return [];
        if (!isRegularFile(targetPath)) {
          throw new Error(
            'CODEX_RUNTIME_HOME_REBASE_TARGET_MISSING: '
            + `thread ${row.id} rollout is missing at ${targetPath}`
          );
        }
        return [{ id: row.id, targetPath }];
      });
      const update = database.prepare(`
        UPDATE threads
        SET rollout_path = ?
        WHERE id = ?
      `);
      database.transaction(() => {
        for (const entry of updates) {
          update.run(entry.targetPath, entry.id);
        }
      })();
      pathsRebased += updates.length;
      database.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      database.close();
    }
  }

  return { databasesInspected, pathsRebased };
}

function listCodexStateDatabases(stableHome: string): string[] {
  if (!existsSync(stableHome) || !statSync(stableHome).isDirectory()) return [];
  return readdirSync(stableHome)
    .filter(filename => /^state_\d+\.sqlite$/.test(filename))
    .sort();
}

function rebaseLegacyRolloutPath(
  rolloutPath: string,
  stableHome: string,
  legacyRoots: string[]
): string | null {
  const absolutePath = resolve(rolloutPath);
  for (const legacyRoot of legacyRoots) {
    const legacyRelativePath = relative(legacyRoot, absolutePath);
    if (
      legacyRelativePath.length === 0
      || legacyRelativePath === '..'
      || legacyRelativePath.startsWith(`..${sep}`)
      || isAbsolute(legacyRelativePath)
    ) {
      continue;
    }
    const [, ...runtimeRelativeParts] = legacyRelativePath.split(sep);
    if (runtimeRelativeParts.length === 0) continue;
    return join(stableHome, ...runtimeRelativeParts);
  }
  return null;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
