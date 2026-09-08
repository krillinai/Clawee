import type Database from 'better-sqlite3';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodexRuntimeLaunchContext } from '@clawee/protocol';
import type {
  CodexAppServerRequestClient,
  CreateCodexAppServerClientInput
} from '../../src/codex/app-server-client.js';
import {
  createCodexHomeMigrationService,
  runtimeMigrationSyncOpenMode,
  type CodexActivatedTargetValidation,
  type CodexHomeMigrationPhase
} from '../../src/codex/runtime-home-migration.js';
import {
  createCodexSessionIndexRepository
} from '../../src/codex/sessions/index-repository.js';
import {
  createCodexSessionIndexer
} from '../../src/codex/sessions/indexer.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { createThreadRepository } from '../../src/storage/repositories.js';
import { createFakeAppServer } from '../helpers/fake-app-server.js';

const THREAD_IDS = [
  '019f0000-0000-7000-8000-000000000001',
  '019f0000-0000-7000-8000-000000000002',
  '019f0000-0000-7000-8000-000000000003'
] as const;

let tempDir = '';
const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  if (tempDir.length > 0) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Codex Runtime Home migration', () => {
  it('opens copied files with a writable handle before fsync on Windows', () => {
    expect(runtimeMigrationSyncOpenMode('win32')).toBe('r+');
    expect(runtimeMigrationSyncOpenMode('darwin')).toBe('r');
    expect(runtimeMigrationSyncOpenMode('linux')).toBe('r');
  });

  it('ignores an external Codex Home and starts with an empty isolated Home', async () => {
    const setup = createSetup('fresh-isolated-home', [THREAD_IDS[0]]);
    const externalHome = join(tempDir, 'external-codex-home');
    const sourcePath = writeRollout(
      externalHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    const sourceContents = readFileSync(sourcePath, 'utf8');
    createCodexSessionIndexer({
      codexHome: externalHome,
      repository: createCodexSessionIndexRepository(setup.database)
    }).sync();
    setup.runtime.candidate.source = 'external-development';
    setup.runtime.candidate.migrationSourceHome = externalHome;
    setup.runtime.previous = null;

    await expect(setup.service().migrate()).resolves.toEqual({
      status: 'not_required',
      sourceManifestSha256: null,
      journalPath: '',
      migratedThreadIds: []
    });

    expect(existsSync(setup.targetHome)).toBe(true);
    expect(findFiles(setup.targetHome, '.jsonl')).toEqual([]);
    expect(findFiles(setup.journalDirectory, '.journal.jsonl')).toEqual([]);
    expect(readFileSync(sourcePath, 'utf8')).toBe(sourceContents);
    expect(setup.fake.readMessages()).toEqual([]);
  });

  it('migrates a Clawee-managed development Home without enabling arbitrary external Homes', async () => {
    const setup = createSetup('managed-development-home', [THREAD_IDS[0]]);
    const sourcePath = writeRollout(
      setup.sourceHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    indexSourceHome(setup);
    setup.runtime.candidate.source = 'external-development';
    setup.runtime.candidate.migrationSourceHome = setup.sourceHome;
    setup.runtime.previous = null;

    const result = await setup.service().migrate();

    expect(result).toMatchObject({
      status: 'activated',
      migratedThreadIds: [THREAD_IDS[0]]
    });
    expect(readFileSync(
      join(
        setup.targetHome,
        'sessions/2026/08/20',
        rolloutFilename(THREAD_IDS[0])
      ),
      'utf8'
    )).toBe(readFileSync(sourcePath, 'utf8'));
  });

  it.each([
    {
      previousVersion: '0.145.0',
      candidateVersion: '0.151.0'
    },
    {
      previousVersion: '0.146.0',
      candidateVersion: '0.150.0'
    }
  ])(
    'rejects unsupported Home migration $previousVersion -> $candidateVersion',
    async ({ previousVersion, candidateVersion }) => {
      const setup = createSetup(
        `unsupported-${previousVersion}-${candidateVersion}`,
        [],
        previousVersion
      );
      setup.runtime.candidate.codexVersion = candidateVersion;

      await expect(setup.service().migrate()).rejects.toMatchObject({
        code: 'CODEX_RUNTIME_MIGRATION_LAYOUT_UNSUPPORTED'
      });
      expect(existsSync(setup.targetHome)).toBe(false);
    }
  );

  it('moves the complete managed Home into a fresh stable Home', async () => {
    const setup = createSetup('success', THREAD_IDS);
    const sourcePaths = [
      writeRollout(setup.sourceHome, 'sessions/2026/08/20', THREAD_IDS[0]),
      writeRollout(setup.sourceHome, 'sessions/2026/08/21', THREAD_IDS[1]),
      writeRollout(setup.sourceHome, 'archived_sessions', THREAD_IDS[2])
    ];
    writeFile(setup.sourceHome, 'config.toml', 'model = "user-model"\n');
    writeFile(setup.sourceHome, 'auth.json', '{"token":"secret"}\n');
    writeFile(setup.sourceHome, 'plugins/private/config.json', '{"enabled":true}\n');
    writeFile(setup.sourceHome, 'skills/private/SKILL.md', '# Private\n');
    writeFile(setup.sourceHome, '.tmp/plugins/cache.json', '{"cached":true}\n');
    writeFile(setup.sourceHome, 'tmp/placeholder', 'transient\n');
    if (process.platform !== 'win32') {
      symlinkSync(
        sourcePaths[0]!,
        join(setup.sourceHome, 'tmp', 'apply_patch')
      );
    }
    indexSourceHome(setup);

    const result = await setup.service().migrate();

    expect(result).toMatchObject({
      status: 'activated',
      migratedThreadIds: [...THREAD_IDS]
    });
    for (const sourcePath of sourcePaths) {
      const relativePath = sourcePath.slice(setup.sourceHome.length + 1);
      expect(readFileSync(join(setup.targetHome, relativePath), 'utf8')).toBe(
        readFileSync(sourcePath, 'utf8')
      );
    }
    expect(readFileSync(join(setup.targetHome, 'config.toml'), 'utf8'))
      .toBe('model = "user-model"\n');
    expect(readFileSync(join(setup.targetHome, 'auth.json'), 'utf8'))
      .toBe('{"token":"secret"}\n');
    expect(readFileSync(
      join(setup.targetHome, 'plugins/private/config.json'),
      'utf8'
    )).toBe('{"enabled":true}\n');
    expect(readFileSync(
      join(setup.targetHome, 'skills/private/SKILL.md'),
      'utf8'
    )).toBe('# Private\n');
    expect(existsSync(join(setup.targetHome, '.tmp'))).toBe(false);
    expect(existsSync(join(setup.targetHome, 'tmp'))).toBe(false);

    const reads = setup.fake.readMessages().filter(
      message => message.method === 'thread/read'
    );
    expect(reads.map(message => message.params)).toEqual(
      THREAD_IDS.map(threadId => ({
        threadId,
        includeTurns: true
      }))
    );
    expect(readJournal(result.journalPath)).toEqual([
      expect.objectContaining({
        type: 'manifest',
        runtimeId: setup.runtime.candidate.runtimeId,
        threads: expect.arrayContaining(THREAD_IDS.map((codexThreadId, index) =>
          expect.objectContaining({
            claweeThreadId: `thread_${index + 1}`,
            codexThreadId,
            recoverableBeforeMigration: true,
            copyStatus: 'pending',
            verificationStatus: 'pending',
            errorCode: null
          })
        ))
      }),
      expect.objectContaining({ type: 'transition', from: 'planned', to: 'copied' }),
      expect.objectContaining({ type: 'transition', from: 'copied', to: 'verified' }),
      expect.objectContaining({ type: 'transition', from: 'verified', to: 'activated' })
    ]);
  });

  it('relocates a same-version managed Home without creating a new version Home', async () => {
    const setup = createSetup(
      'same-version-relocation',
      [THREAD_IDS[0]],
      '0.151.0'
    );
    const sourcePath = writeRollout(
      setup.sourceHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    writeFileSync(
      join(setup.sourceHome, 'config.toml'),
      'model = "clawee"\n'
    );
    indexSourceHome(setup);

    const result = await setup.service().migrate();

    expect(result).toMatchObject({
      status: 'activated',
      migratedThreadIds: [THREAD_IDS[0]]
    });
    expect(readFileSync(
      join(
        setup.targetHome,
        'sessions/2026/08/20',
        rolloutFilename(THREAD_IDS[0])
      ),
      'utf8'
    )).toBe(readFileSync(sourcePath, 'utf8'));
    expect(readFileSync(join(setup.targetHome, 'config.toml'), 'utf8'))
      .toBe('model = "clawee"\n');
    expect(readFileSync(
      join(setup.targetHome, '.clawee', 'runtime-home-layout-1'),
      'utf8'
    )).toBe('managed-by-clawee\n');
  });

  it('merges rollout files into an existing Runtime-owned Home without replacing its state', async () => {
    const setup = createSetup('existing-runtime-home', [THREAD_IDS[0]]);
    const sourcePath = writeRollout(
      setup.sourceHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    indexSourceHome(setup);
    setup.runtime.candidate.source = 'external-development';
    setup.runtime.candidate.migrationSourceHome = setup.sourceHome;
    setup.runtime.previous = null;

    writeFile(setup.targetHome, 'config.toml', '[features]\nmulti_agent = false\n');
    writeFile(setup.targetHome, 'state_5.sqlite', 'current Runtime state');
    writeFile(setup.targetHome, 'skills/.system/SKILL.md', '# Current Runtime skill\n');
    const targetOnlyPath = writeRollout(
      setup.targetHome,
      'sessions/2026/09/03',
      THREAD_IDS[1]
    );
    const threads = createThreadRepository(setup.database);
    threads.insertThread({
      id: 'thread_target_only',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active'
    });
    threads.setCodexThreadId('thread_target_only', THREAD_IDS[1]);

    const result = await setup.service().migrate();

    expect(result).toMatchObject({
      status: 'activated',
      migratedThreadIds: [THREAD_IDS[0]]
    });
    expect(readFileSync(join(setup.targetHome, 'config.toml'), 'utf8'))
      .toBe('[features]\nmulti_agent = false\n');
    expect(readFileSync(join(setup.targetHome, 'state_5.sqlite'), 'utf8'))
      .toBe('current Runtime state');
    expect(readFileSync(
      join(setup.targetHome, 'skills/.system/SKILL.md'),
      'utf8'
    )).toBe('# Current Runtime skill\n');
    expect(readFileSync(targetOnlyPath, 'utf8')).toContain(THREAD_IDS[1]);
    expect(readFileSync(
      join(
        setup.targetHome,
        'sessions/2026/08/20',
        rolloutFilename(THREAD_IDS[0])
      ),
      'utf8'
    )).toBe(readFileSync(sourcePath, 'utf8'));
  });

  it('rejects a conflicting rollout in an existing Runtime-owned Home', async () => {
    const setup = createSetup('existing-runtime-conflict', [THREAD_IDS[0]]);
    writeRollout(
      setup.sourceHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    indexSourceHome(setup);
    const targetPath = writeRollout(
      setup.targetHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    appendFileSync(targetPath, `${JSON.stringify({
      timestamp: '2026-09-03T10:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'conflicting target state'
      }
    })}\n`, 'utf8');
    setup.runtime.candidate.source = 'external-development';
    setup.runtime.candidate.migrationSourceHome = setup.sourceHome;
    setup.runtime.previous = null;

    await expect(setup.service().migrate()).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_MIGRATION_TARGET_INVALID'
    });
    expect(readFileSync(targetPath, 'utf8')).toContain('conflicting target state');
    expect(findFiles(setup.journalDirectory, '.journal.jsonl')).toEqual([]);
  });

  it('retries an interrupted merge into an existing Runtime-owned Home', async () => {
    const setup = createSetup('existing-runtime-retry', [THREAD_IDS[0]]);
    const sourcePath = writeRollout(
      setup.sourceHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    indexSourceHome(setup);
    writeFile(setup.targetHome, 'state_5.sqlite', 'preserved');
    setup.runtime.candidate.source = 'external-development';
    setup.runtime.candidate.migrationSourceHome = setup.sourceHome;
    setup.runtime.previous = null;
    let interrupted = false;

    await expect(setup.service({
      onPhase(phase) {
        if (!interrupted && phase === 'verified') {
          interrupted = true;
          throw new Error('simulated crash before existing Home merge');
        }
      }
    }).migrate()).rejects.toThrow('simulated crash before existing Home merge');

    const result = await setup.service().migrate();
    expect(result.status).toBe('activated');
    expect(readFileSync(join(setup.targetHome, 'state_5.sqlite'), 'utf8'))
      .toBe('preserved');
    expect(readFileSync(
      join(
        setup.targetHome,
        'sessions/2026/08/20',
        rolloutFilename(THREAD_IDS[0])
      ),
      'utf8'
    )).toBe(readFileSync(sourcePath, 'utf8'));
  });

  it('isolates app-server verification side effects from the activated Home', async () => {
    const setup = createSetup('verification-home', [THREAD_IDS[0]]);
    const sourcePath = writeRollout(
      setup.sourceHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    indexSourceHome(setup);
    let verificationHome = '';

    const result = await setup.service({
      createClient(input) {
        verificationHome = input.codexHome;
        expect(readFileSync(
          join(
            input.codexHome,
            'sessions/2026/08/20',
            rolloutFilename(THREAD_IDS[0])
          ),
          'utf8'
        )).toBe(readFileSync(sourcePath, 'utf8'));
        writeFile(input.codexHome, 'state_5.sqlite', 'verification state');
        writeFile(input.codexHome, 'skills/.system/SKILL.md', '# Generated\n');
        writeFile(input.codexHome, 'logs/codex.log', 'verification log\n');
        return {
          async request<Result>(
            method: string,
            params: unknown
          ): Promise<Result> {
            expect({ method, params }).toEqual({
              method: 'thread/read',
              params: {
                threadId: THREAD_IDS[0],
                includeTurns: true
              }
            });
            return {
              thread: {
                id: THREAD_IDS[0],
                turns: []
              }
            } as Result;
          },
          async close() {}
        };
      }
    }).migrate();

    const stagingHome =
      `${setup.targetHome}.staging-${result.sourceManifestSha256}`;
    expect(verificationHome).toBe(join(
      dirname(stagingHome),
      `.verification-${result.sourceManifestSha256}`
    ));
    expect(verificationHome).not.toBe(setup.targetHome);
    expect(existsSync(verificationHome)).toBe(false);
    expect(existsSync(join(setup.targetHome, 'state_5.sqlite'))).toBe(false);
    expect(existsSync(join(setup.targetHome, 'skills'))).toBe(false);
    expect(existsSync(join(setup.targetHome, 'logs'))).toBe(false);
    expect(readFileSync(
      join(
        setup.targetHome,
        'sessions/2026/08/20',
        rolloutFilename(THREAD_IDS[0])
      ),
      'utf8'
    )).toBe(readFileSync(sourcePath, 'utf8'));
  });

  it.each([
    {
      name: 'missing source',
      code: 'CODEX_RUNTIME_MIGRATION_SOURCE_MISSING',
      prepare() {}
    },
    {
      name: 'duplicate source',
      code: 'CODEX_RUNTIME_MIGRATION_SOURCE_DUPLICATE',
      prepare(sourceHome: string) {
        writeRollout(sourceHome, 'sessions/2026/08/20', THREAD_IDS[0]);
        writeRollout(sourceHome, 'sessions/2026/08/21', THREAD_IDS[0]);
      }
    },
    {
      name: 'corrupt source',
      code: 'CODEX_RUNTIME_MIGRATION_SOURCE_CORRUPT',
      prepare(sourceHome: string) {
        const path = writeRollout(sourceHome, 'sessions/2026/08/20', THREAD_IDS[0]);
        writeFileSync(path, `${readFileSync(path, 'utf8')}not-json\n`, 'utf8');
      }
    },
    {
      name: 'paginated source',
      code: 'CODEX_RUNTIME_MIGRATION_PAGINATED_UNSUPPORTED',
      prepare(sourceHome: string) {
        const path = writeRollout(sourceHome, 'sessions/2026/08/20', THREAD_IDS[0]);
        writeFileSync(
          path,
          readFileSync(path, 'utf8').replace(
            '"history_mode":"legacy"',
            '"history_mode":"paginated"'
          ),
          'utf8'
        );
      }
    }
  ])('blocks activation for $name', async scenario => {
    const setup = createSetup(`failure-${scenario.name}`, [THREAD_IDS[0]]);
    scenario.prepare(setup.sourceHome);
    indexSourceHome(setup);

    await expect(setup.service().migrate()).rejects.toMatchObject({
      code: scenario.code
    });
    expect(existsSync(setup.targetHome)).toBe(false);
    expect(existsSync(setup.sourceHome)).toBe(true);
    expect(setup.fake.readMessages().some(
      message => message.method === 'thread/read'
    )).toBe(false);
  });

  it('blocks activation when a source changes after copy', async () => {
    const setup = createSetup('source-change', [THREAD_IDS[0]]);
    const sourcePath = writeRollout(
      setup.sourceHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    indexSourceHome(setup);

    await expect(setup.service({
      onPhase(phase) {
        if (phase === 'files_copied') {
          writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')} \n`, 'utf8');
        }
      }
    }).migrate()).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_MIGRATION_SOURCE_CHANGED'
    });

    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(setup.targetHome)).toBe(false);
    expect(setup.fake.readMessages().some(
      message => message.method === 'thread/read'
    )).toBe(false);
  });

  it('archives a failed journal and retries the same migration manifest', async () => {
    const setup = createSetup('retry-failed-journal', [THREAD_IDS[0]]);
    writeRollout(
      setup.sourceHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    indexSourceHome(setup);

    await expect(setup.service({
      createClient() {
        return {
          async request<Result>(): Promise<Result> {
            throw new Error('simulated verification failure');
          },
          async close() {}
        };
      }
    }).migrate()).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_MIGRATION_VERIFICATION_FAILED'
    });

    const result = await setup.service().migrate();

    expect(result.status).toBe('activated');
    expect(existsSync(join(
      setup.journalDirectory,
      'failed',
      basename(result.journalPath)
    ))).toBe(true);
  });

  it('activates an empty manifest so later Runtime-owned threads do not trigger remigration', async () => {
    const setup = createSetup('empty-manifest', []);

    const first = await setup.service().migrate();
    expect(first).toMatchObject({
      status: 'activated',
      migratedThreadIds: []
    });
    writeFile(setup.targetHome, 'config.toml', '[features]\nmulti_agent = false\n');

    const threads = createThreadRepository(setup.database);
    threads.insertThread({
      id: 'thread_after_activation',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active'
    });
    threads.setCodexThreadId('thread_after_activation', THREAD_IDS[0]);
    writeRollout(setup.targetHome, 'sessions/2026/08/21', THREAD_IDS[0]);

    await expect(setup.service().migrate()).resolves.toMatchObject({
      status: 'already_activated',
      sourceManifestSha256: first.sourceManifestSha256,
      migratedThreadIds: []
    });
    expect(existsSync(join(setup.targetHome, 'config.toml'))).toBe(true);
    expect(setup.fake.readMessages().some(
      message => message.method === 'thread/read'
    )).toBe(false);
  });

  it('allows committed Runtime writes but detects changes before Runtime ownership', async () => {
    const setup = createSetup('runtime-owned-target', [THREAD_IDS[0]]);
    const sourcePath = writeRollout(
      setup.sourceHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    indexSourceHome(setup);

    await setup.service().migrate();
    const targetPath = join(
      setup.targetHome,
      'sessions/2026/08/20',
      rolloutFilename(THREAD_IDS[0])
    );
    appendFileSync(targetPath, `${JSON.stringify({
      timestamp: '2026-08-21T10:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Runtime-owned response'
      }
    })}\n`, 'utf8');

    await expect(setup.service().migrate()).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_MIGRATION_TARGET_INVALID'
    });
    await expect(setup.service({
      activatedTargetValidation: 'runtime_owned'
    }).migrate()).resolves.toMatchObject({
      status: 'already_activated',
      migratedThreadIds: [THREAD_IDS[0]]
    });
    expect(readFileSync(sourcePath, 'utf8')).not.toBe(
      readFileSync(targetPath, 'utf8')
    );
  });

  it('allows an activated development Home to change before the next restart', async () => {
    const setup = createSetup('development-runtime-owned-target', [THREAD_IDS[0]]);
    setup.runtime.candidate.source = 'external-development';
    writeRollout(
      setup.sourceHome,
      'sessions/2026/08/20',
      THREAD_IDS[0]
    );
    indexSourceHome(setup);

    await setup.service().migrate();
    const targetPath = join(
      setup.targetHome,
      'sessions/2026/08/20',
      rolloutFilename(THREAD_IDS[0])
    );
    appendFileSync(targetPath, `${JSON.stringify({
      timestamp: '2026-08-21T10:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Development Runtime response'
      }
    })}\n`, 'utf8');

    await expect(setup.service().migrate()).resolves.toMatchObject({
      status: 'already_activated',
      migratedThreadIds: [THREAD_IDS[0]]
    });
  });

  it('recovers idempotently from every persisted migration boundary', async () => {
    const phases: CodexHomeMigrationPhase[] = [
      'manifest',
      'copied',
      'verified',
      'activated'
    ];

    for (const phase of phases) {
      const setup = createSetup(`crash-${phase}`, [THREAD_IDS[0]]);
      const sourcePath = writeRollout(
        setup.sourceHome,
        'sessions/2026/08/20',
        THREAD_IDS[0]
      );
      const sourceContents = readFileSync(sourcePath, 'utf8');
      indexSourceHome(setup);
      let interrupted = false;

      await expect(setup.service({
        onPhase(current) {
          if (!interrupted && current === phase) {
            interrupted = true;
            throw new Error(`simulated crash after ${phase}`);
          }
        }
      }).migrate()).rejects.toThrow(`simulated crash after ${phase}`);

      if (phase === 'manifest') {
        const [journalPath] = findFiles(
          setup.journalDirectory,
          '.journal.jsonl'
        );
        appendFileSync(journalPath!, '{"type":"transition"', 'utf8');
      }
      const result = await setup.service().migrate();
      expect(result.status).toMatch(/activated/);
      expect(readFileSync(sourcePath, 'utf8')).toBe(sourceContents);
      expect(readFileSync(
        join(
          setup.targetHome,
          'sessions/2026/08/20',
          rolloutFilename(THREAD_IDS[0])
        ),
        'utf8'
      )).toBe(sourceContents);
      expect(findFiles(setup.journalDirectory, '.journal.jsonl')).toHaveLength(1);
      const records = readJournal(result.journalPath);
      expect(records.filter(record => record.type === 'manifest')).toHaveLength(1);
      expect(records.filter(record =>
        record.type === 'transition' && record.to === 'copied'
      )).toHaveLength(1);
      expect(records.filter(record =>
        record.type === 'transition' && record.to === 'verified'
      )).toHaveLength(1);
      expect(records.filter(record =>
        record.type === 'transition' && record.to === 'activated'
      )).toHaveLength(1);
      expect(setup.fake.readMessages().filter(
        message => message.method === 'thread/read'
      )).toHaveLength(1);
    }
  }, 30_000);
});

function createSetup(
  name: string,
  codexThreadIds: readonly string[],
  sourceVersion = '0.146.0'
): {
  sourceHome: string;
  targetHome: string;
  journalDirectory: string;
  runtime: CodexRuntimeLaunchContext;
  fake: ReturnType<typeof createFakeAppServer>;
  database: Database.Database;
  service(input?: {
    onPhase?(phase: CodexHomeMigrationPhase): void;
    activatedTargetValidation?: CodexActivatedTargetValidation;
    createClient?(
      input: CreateCodexAppServerClientInput
    ): CodexAppServerRequestClient;
  }): ReturnType<typeof createCodexHomeMigrationService>;
} {
  if (tempDir.length === 0) {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-home-migration-'));
  }
  const root = join(tempDir, name.replaceAll(' ', '-'));
  const dataDir = join(root, 'data');
  const sourceHome = join(
    dataDir,
    'codex',
    'homes',
    `codex-rust-v${sourceVersion}-layout-1-web-dev`
  );
  const targetHome = join(dataDir, 'codex-home');
  const journalDirectory = join(dataDir, 'codex', 'migrations', 'runtime-1');
  mkdirSync(sourceHome, { recursive: true });
  const fake = createFakeAppServer({
    directory: join(root, 'fake'),
    readableThreadIds: [...codexThreadIds]
  });
  const database = openRuntimeDatabase(join(dataDir, 'app.sqlite'));
  databases.push(database);
  const threads = createThreadRepository(database);
  codexThreadIds.forEach((codexThreadId, index) => {
    threads.insertThread({
      id: `thread_${index + 1}`,
      cwd: root,
      canonicalCwd: root,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: index === codexThreadIds.length - 1 ? 'archived' : 'active'
    });
    threads.setCodexThreadId(`thread_${index + 1}`, codexThreadId);
  });
  const runtime: CodexRuntimeLaunchContext = {
    candidate: {
      runtimeId: 'runtime-1',
      source: 'embedded-package',
      codexVersion: '0.151.0',
      releaseTag: 'rust-v0.151.0',
      target: 'aarch64-apple-darwin',
      layoutVersion: 1,
      entryPath: fake.bin,
      homePath: targetHome,
      contentSha256: 'a'.repeat(64),
      minimumClaweeVersion: '1.0.0',
      migrationSourceHome: sourceHome
    },
    previous: null,
    claweeVersion: '1.0.0'
  };
  return {
    sourceHome,
    targetHome,
    journalDirectory,
    runtime,
    fake,
    database,
    service(input = {}) {
      return createCodexHomeMigrationService({
        runtime,
        dataDir,
        threads,
        sessionIndex: createCodexSessionIndexRepository(database),
        requestTimeoutMs: 10_000,
        ...input
      });
    }
  };
}

function indexSourceHome(setup: ReturnType<typeof createSetup>): void {
  createCodexSessionIndexer({
    codexHome: setup.sourceHome,
    repository: createCodexSessionIndexRepository(setup.database)
  }).sync();
}

function writeRollout(
  home: string,
  relativeDirectory: string,
  threadId: string
): string {
  const path = join(home, relativeDirectory, rolloutFilename(threadId));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    JSON.stringify({
      timestamp: '2026-08-20T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        session_id: threadId,
        timestamp: '2026-08-20T10:00:00.000Z',
        cwd: '/tmp/project',
        history_mode: 'legacy'
      }
    }),
    JSON.stringify({
      timestamp: '2026-08-20T10:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: `Thread ${threadId}`
      }
    }),
    ''
  ].join('\n'), 'utf8');
  return path;
}

function rolloutFilename(threadId: string): string {
  return `rollout-2026-08-20T10-00-00-${threadId}.jsonl`;
}

function writeFile(home: string, relativePath: string, contents: string): void {
  const path = join(home, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function readJournal(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function findFiles(root: string, suffix: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? findFiles(path, suffix)
      : entry.isFile() && entry.name.endsWith(suffix)
        ? [path]
        : [];
  });
}
