import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep
} from 'node:path';
import type { CodexRuntimeLaunchContext } from '@clawee/protocol';
import type { ThreadRepository } from '../storage/repositories.js';
import { openRuntimeDatabase } from '../storage/database.js';
import {
  createCodexAppServerClient,
  type CreateCodexAppServerClientInput
} from './app-server-client.js';
import {
  createCodexSessionIndexRepository,
  type CodexSessionIndexRepository
} from './sessions/index-repository.js';
import { createCodexSessionIndexer } from './sessions/indexer.js';
import {
  inspectCodexRuntimeRolloutFileV0146,
  scanCodexRuntimeHomeV0146,
  targetPathForRuntimeFile,
  type CodexRuntimeRolloutSource
} from './runtime-home-layout.js';
import {
  appendCodexRuntimeMigrationJournalRecord as appendJournalRecord,
  appendCodexRuntimeMigrationTransition as appendTransition,
  fsyncDirectory,
  hashCodexRuntimeMigrationManifest,
  readCodexRuntimeMigrationJournals as readJournals
} from './runtime-home-migration-journal.js';
import {
  CodexHomeMigrationError,
  type CodexHomeMigrationErrorCode,
  type CodexHomeMigrationPhase,
  type CodexHomeMigrationResult,
  type CodexRuntimeMigrationManifest,
  type CodexRuntimeMigrationThread,
  type ParsedCodexRuntimeMigrationJournal
} from './runtime-home-migration-types.js';
import { flushRuntimeFileDescriptor } from './runtime-fsync.js';

export { CodexHomeMigrationError };
export type CodexActivatedTargetValidation =
  | 'migration_integrity'
  | 'runtime_owned';
export type {
  CodexHomeMigrationErrorCode,
  CodexHomeMigrationPhase,
  CodexHomeMigrationResult,
  CodexRuntimeMigrationJournalRecord,
  CodexRuntimeMigrationThread
} from './runtime-home-migration-types.js';

type ServiceInput = {
  runtime: CodexRuntimeLaunchContext;
  dataDir: string;
  threads: Pick<ThreadRepository, 'listCodexMigrationBindings'>;
  sessionIndex: Pick<CodexSessionIndexRepository, 'listMigrationSourceCandidates'>;
  requestTimeoutMs?: number;
  createClient?: typeof createCodexAppServerClient;
  activatedTargetValidation?: CodexActivatedTargetValidation;
  now?: () => Date;
  onPhase?(phase: CodexHomeMigrationPhase): void | Promise<void>;
};

export function createCodexHomeMigrationService(input: ServiceInput): {
  migrate(): Promise<CodexHomeMigrationResult>;
} {
  return {
    async migrate(): Promise<CodexHomeMigrationResult> {
      const candidate = input.runtime.candidate;
      const targetHome = resolve(candidate.homePath);
      const migrationSource = resolveMigrationSource({
        runtime: input.runtime,
        dataDir: input.dataDir,
        targetHome
      });
      const journalDirectory = join(
        resolve(input.dataDir),
        'codex',
        'migrations',
        candidate.runtimeId
      );
      const journals = readJournals(journalDirectory);
      const activated = journals.filter(journal =>
        journal.state === 'activated'
        && journal.manifest.runtimeId === candidate.runtimeId
        && resolve(journal.manifest.targetHome) === targetHome
      );
      if (activated.length > 1) {
        throw migrationError(
          'CODEX_RUNTIME_MIGRATION_JOURNAL_CORRUPT',
          'multiple activated journals target the same Runtime Home'
        );
      }
      if (activated.length === 1) {
        verifyTargetDirectory(targetHome);
        if (
          input.activatedTargetValidation !== 'runtime_owned'
          && candidate.source !== 'external-development'
        ) {
          verifyTargetFiles(targetHome, activated[0]!.manifest);
        }
        markStableHomeActivated(targetHome, candidate.layoutVersion);
        return migrationResult('already_activated', activated[0]!);
      }

      const bindings = input.threads.listCodexMigrationBindings();
      if (
        migrationSource === null
        || migrationSource.homePath === targetHome
      ) {
        mkdirSync(targetHome, { recursive: true, mode: 0o700 });
        markStableHomeActivated(targetHome, candidate.layoutVersion);
        return {
          status: 'not_required',
          sourceManifestSha256: null,
          journalPath: '',
          migratedThreadIds: []
        };
      }
      const sourceHome = migrationSource.homePath;
      const sameLayoutVersion =
        migrationSource.codexVersion === candidate.codexVersion;
      const supportedUpgrade =
        migrationSource.codexVersion === '0.146.0'
        && candidate.codexVersion === '0.151.0';
      if (
        (!sameLayoutVersion && !supportedUpgrade)
        || candidate.layoutVersion !== 1
      ) {
        throw migrationError(
          'CODEX_RUNTIME_MIGRATION_LAYOUT_UNSUPPORTED',
          'unsupported Codex Home migration '
          + `${migrationSource.codexVersion} -> `
          + `${candidate.codexVersion}/${candidate.layoutVersion}`
        );
      }

      const manifest = buildManifest({
        runtimeId: candidate.runtimeId,
        sourceHome,
        targetHome,
        bindings,
        sessionIndex: input.sessionIndex,
        createdAt: nowIso(input.now)
      });
      const journalPath = join(
        journalDirectory,
        `${manifest.sourceManifestSha256}.journal.jsonl`
      );
      let journal = journals.find(existing => existing.path === journalPath);
      if (journal?.state === 'failed') {
        archiveFailedMigrationJournal(journal.path);
        journal = undefined;
      }
      if (journal === undefined) {
        if (existsSync(targetHome)) {
          verifyTargetDirectory(targetHome);
        }
        appendJournalRecord(journalPath, manifest);
        journal = { path: journalPath, manifest, state: 'planned' };
        await input.onPhase?.('manifest');
      }

      const unrecoverable = manifest.threads.find(
        thread => !thread.recoverableBeforeMigration
      );
      if (unrecoverable !== undefined) {
        appendTransition(
          journalPath,
          'planned',
          'failed',
          unrecoverable.errorCode
        );
        throw migrationError(
          asMigrationErrorCode(unrecoverable.errorCode),
          `thread ${unrecoverable.codexThreadId} is not recoverable from the source Home`
        );
      }

      const stagingHome =
        `${targetHome}.staging-${manifest.sourceManifestSha256}`;
      if (journal.state === 'planned') {
        try {
          rmSync(stagingHome, { recursive: true, force: true });
          if (existsSync(targetHome)) {
            mkdirSync(stagingHome, { recursive: true, mode: 0o700 });
          } else {
            copyManagedRuntimeHome(sourceHome, stagingHome);
          }
          copyManifestFiles(sourceHome, stagingHome, manifest);
          await input.onPhase?.('files_copied');
          verifySourceFiles(sourceHome, manifest);
          verifyTargetFiles(stagingHome, manifest);
        } catch (error) {
          rmSync(stagingHome, { recursive: true, force: true });
          const migration = normalizeMigrationError(
            error,
            'CODEX_RUNTIME_MIGRATION_SOURCE_CHANGED'
          );
          appendTransition(journalPath, 'planned', 'failed', migration.code);
          throw migration;
        }
        appendTransition(journalPath, 'planned', 'copied', null);
        journal.state = 'copied';
        await input.onPhase?.('copied');
      }

      if (journal.state === 'copied') {
        try {
          verifySourceFiles(sourceHome, manifest);
          verifyTargetFiles(stagingHome, manifest);
          await verifyStagingHomeWithAppServer({
            codexBin: candidate.entryPath,
            stagingHome,
            manifest,
            requestTimeoutMs: input.requestTimeoutMs,
            createClient: input.createClient
          });
          verifyTargetFiles(stagingHome, manifest);
        } catch (error) {
          rmSync(stagingHome, { recursive: true, force: true });
          const migration = normalizeMigrationError(
            error,
            'CODEX_RUNTIME_MIGRATION_VERIFICATION_FAILED'
          );
          appendTransition(journalPath, 'copied', 'failed', migration.code);
          throw migration;
        }
        appendTransition(journalPath, 'copied', 'verified', null);
        journal.state = 'verified';
        await input.onPhase?.('verified');
      }

      if (journal.state === 'verified') {
        try {
          verifySourceFiles(sourceHome, manifest);
          if (existsSync(stagingHome)) {
            verifyTargetFiles(stagingHome, manifest);
            if (existsSync(targetHome)) {
              mergeManifestFiles(stagingHome, targetHome, manifest);
            } else {
              mkdirSync(dirname(targetHome), { recursive: true, mode: 0o700 });
              renameSync(stagingHome, targetHome);
              fsyncDirectory(dirname(targetHome));
            }
          }
          verifyTargetFiles(targetHome, manifest);
        } catch (error) {
          const migration = normalizeMigrationError(
            error,
            'CODEX_RUNTIME_MIGRATION_TARGET_INVALID'
          );
          appendTransition(journalPath, 'verified', 'failed', migration.code);
          throw migration;
        }
        appendTransition(journalPath, 'verified', 'activated', null);
        journal.state = 'activated';
        markStableHomeActivated(targetHome, candidate.layoutVersion);
        removeMigrationDirectory(stagingHome);
        await input.onPhase?.('activated');
      }

      return migrationResult('activated', journal);
    }
  };
}

function markStableHomeActivated(
  targetHome: string,
  layoutVersion: number
): void {
  const markerDirectory = join(targetHome, '.clawee');
  const marker = join(
    markerDirectory,
    `runtime-home-layout-${layoutVersion}`
  );
  mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
  if (!existsSync(marker)) {
    writeFileSync(marker, 'managed-by-clawee\n', { mode: 0o600 });
    fsyncFile(marker);
  }
  fsyncDirectory(markerDirectory);
  fsyncDirectory(targetHome);
}

function archiveFailedMigrationJournal(path: string): void {
  const journalDirectory = dirname(path);
  const failedDirectory = join(journalDirectory, 'failed');
  const archivedPath = join(failedDirectory, basename(path));
  mkdirSync(failedDirectory, { recursive: true, mode: 0o700 });
  rmSync(archivedPath, { force: true });
  renameSync(path, archivedPath);
  fsyncDirectory(failedDirectory);
  fsyncDirectory(journalDirectory);
}

function resolveMigrationSource(input: {
  runtime: CodexRuntimeLaunchContext;
  dataDir: string;
  targetHome: string;
}): { homePath: string; codexVersion: string } | null {
  const candidate = input.runtime.candidate;
  if (candidate.migrationSourceHome === null) {
    return null;
  }
  const managedHomes = resolve(input.dataDir, 'codex', 'homes');
  const sourceHome = resolve(candidate.migrationSourceHome);
  if (dirname(sourceHome) !== managedHomes) {
    return null;
  }
  const match = basename(sourceHome).match(
    /^codex-rust-v(\d+\.\d+\.\d+)-layout-(\d+)(?:-(?:server|web-dev))?$/
  );
  if (match === null || Number(match[2]) !== candidate.layoutVersion) {
    return null;
  }
  return {
    homePath: sourceHome,
    codexVersion: match[1]!
  };
}

function buildManifest(input: {
  runtimeId: string;
  sourceHome: string;
  targetHome: string;
  bindings: Array<{ claweeThreadId: string; codexThreadId: string }>;
  sessionIndex: Pick<CodexSessionIndexRepository, 'listMigrationSourceCandidates'>;
  createdAt: string;
}): CodexRuntimeMigrationManifest {
  const scan = scanCodexRuntimeHomeV0146(input.sourceHome);
  const targetScan = existsSync(input.targetHome)
    ? scanCodexRuntimeHomeV0146(input.targetHome)
    : { sources: [], issues: [] };
  const sourcesByThread = new Map<string, CodexRuntimeRolloutSource[]>();
  for (const source of scan.sources) {
    const sources = sourcesByThread.get(source.codexThreadId) ?? [];
    sources.push(source);
    sourcesByThread.set(source.codexThreadId, sources);
  }
  const targetSourcesByThread = new Map<string, CodexRuntimeRolloutSource[]>();
  for (const source of targetScan.sources) {
    const sources = targetSourcesByThread.get(source.codexThreadId) ?? [];
    sources.push(source);
    targetSourcesByThread.set(source.codexThreadId, sources);
  }
  const indexedPaths = new Map(
    input.sessionIndex
      .listMigrationSourceCandidates(
        input.bindings.map(binding => binding.codexThreadId)
      )
      .filter(candidate => pathInside(input.sourceHome, candidate.sourcePath))
      .map(candidate => [candidate.codexThreadId, resolve(candidate.sourcePath)])
  );
  const threads = input.bindings
    .filter(binding => shouldMigrateBinding({
      binding,
      sourceIssues: scan.issues,
      sourceMatches: sourcesByThread.get(binding.codexThreadId) ?? [],
      targetIssues: targetScan.issues,
      targetMatches: targetSourcesByThread.get(binding.codexThreadId) ?? []
    }))
    .map(binding => migrationThread(
      binding,
      input.sourceHome,
      sourcesByThread,
      scan.issues,
      indexedPaths.get(binding.codexThreadId)
    ))
    .sort((left, right) => left.claweeThreadId.localeCompare(right.claweeThreadId));
  const hashMaterial = {
    schemaVersion: 1 as const,
    runtimeId: input.runtimeId,
    sourceHome: input.sourceHome,
    targetHome: input.targetHome,
    threads
  };
  const sourceManifestSha256 =
    hashCodexRuntimeMigrationManifest(hashMaterial);
  return {
    type: 'manifest',
    schemaVersion: 1,
    runtimeId: input.runtimeId,
    sourceManifestSha256,
    sourceHome: input.sourceHome,
    targetHome: input.targetHome,
    threads,
    createdAt: input.createdAt
  };
}

function shouldMigrateBinding(input: {
  binding: { claweeThreadId: string; codexThreadId: string };
  sourceIssues: ReturnType<typeof scanCodexRuntimeHomeV0146>['issues'];
  sourceMatches: CodexRuntimeRolloutSource[];
  targetIssues: ReturnType<typeof scanCodexRuntimeHomeV0146>['issues'];
  targetMatches: CodexRuntimeRolloutSource[];
}): boolean {
  const sourceIssue = input.sourceIssues.some(
    issue => issue.filenameThreadId === input.binding.codexThreadId.toLowerCase()
  );
  const targetIssue = input.targetIssues.some(
    issue => issue.filenameThreadId === input.binding.codexThreadId.toLowerCase()
  );
  if (targetIssue || input.targetMatches.length > 1) {
    throw migrationError(
      'CODEX_RUNTIME_MIGRATION_TARGET_INVALID',
      `target contains an invalid rollout for thread ${input.binding.codexThreadId}`
    );
  }
  if (input.targetMatches.length === 1 && input.sourceMatches.length === 1) {
    const source = input.sourceMatches[0]!;
    const target = input.targetMatches[0]!;
    if (
      source.relativePath !== target.relativePath
      || source.size !== target.size
      || source.sha256 !== target.sha256
    ) {
      throw migrationError(
        'CODEX_RUNTIME_MIGRATION_TARGET_INVALID',
        `target contains a conflicting rollout for thread ${input.binding.codexThreadId}`
      );
    }
  }
  return !(
    input.sourceMatches.length === 0
    && !sourceIssue
    && input.targetMatches.length === 1
  );
}

function migrationThread(
  binding: { claweeThreadId: string; codexThreadId: string },
  sourceHome: string,
  sourcesByThread: Map<string, CodexRuntimeRolloutSource[]>,
  issues: ReturnType<typeof scanCodexRuntimeHomeV0146>['issues'],
  indexedPath: string | undefined
): CodexRuntimeMigrationThread {
  const sources = sourcesByThread.get(binding.codexThreadId) ?? [];
  const relatedIssue = issues.find(
    issue => issue.filenameThreadId === binding.codexThreadId.toLowerCase()
  );
  let errorCode: CodexHomeMigrationErrorCode | null = null;
  if (relatedIssue !== undefined) {
    errorCode = relatedIssue.code === 'changed'
      ? 'CODEX_RUNTIME_MIGRATION_SOURCE_CHANGED'
      : 'CODEX_RUNTIME_MIGRATION_SOURCE_CORRUPT';
  } else if (sources.length === 0) {
    errorCode = 'CODEX_RUNTIME_MIGRATION_SOURCE_MISSING';
  } else if (sources.length > 1) {
    errorCode = 'CODEX_RUNTIME_MIGRATION_SOURCE_DUPLICATE';
  }
  const source = sources.length === 1 ? sources[0]! : undefined;
  if (
    errorCode === null
    && indexedPath !== undefined
    && resolve(source!.absolutePath) !== indexedPath
  ) {
    errorCode = 'CODEX_RUNTIME_MIGRATION_SOURCE_DUPLICATE';
  }
  if (errorCode === null && source!.historyMode === 'paginated') {
    errorCode = 'CODEX_RUNTIME_MIGRATION_PAGINATED_UNSUPPORTED';
  }
  const companionFiles = source === undefined
    ? []
    : resolveCompanionFiles(source, sourcesByThread);
  if (
    errorCode === null
    && source?.historyBaseThreadId !== null
    && companionFiles.length === 0
  ) {
    errorCode = 'CODEX_RUNTIME_MIGRATION_SOURCE_MISSING';
  }
  return {
    claweeThreadId: binding.claweeThreadId,
    codexThreadId: binding.codexThreadId,
    recoverableBeforeMigration: errorCode === null,
    sourceRelativePath: source?.relativePath ?? null,
    sourceSize: source?.size ?? null,
    sourceMtimeMs: source?.mtimeMs ?? null,
    sourceSha256: source?.sha256 ?? null,
    companionFiles,
    copyStatus: errorCode === null ? 'pending' : 'not_recoverable',
    verificationStatus: errorCode === null ? 'pending' : 'not_applicable',
    errorCode
  };
}

function resolveCompanionFiles(
  source: CodexRuntimeRolloutSource,
  sourcesByThread: Map<string, CodexRuntimeRolloutSource[]>
): CodexRuntimeMigrationThread['companionFiles'] {
  const companions: CodexRuntimeMigrationThread['companionFiles'] = [];
  const seen = new Set([source.codexThreadId]);
  let historyBaseThreadId = source.historyBaseThreadId;
  while (historyBaseThreadId !== null) {
    if (seen.has(historyBaseThreadId)) return [];
    seen.add(historyBaseThreadId);
    const matches = sourcesByThread.get(historyBaseThreadId) ?? [];
    if (matches.length !== 1) return [];
    const companion = matches[0]!;
    companions.push({
      relativePath: companion.relativePath,
      size: companion.size,
      sha256: companion.sha256
    });
    historyBaseThreadId = companion.historyBaseThreadId;
  }
  return companions.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}

function copyManifestFiles(
  sourceHome: string,
  stagingHome: string,
  manifest: CodexRuntimeMigrationManifest
): void {
  const relativePaths = manifestRelativePaths(manifest);
  for (const relativePath of relativePaths) {
    const source = targetPathForRuntimeFile(sourceHome, relativePath);
    const target = targetPathForRuntimeFile(stagingHome, relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    fsyncFile(target);
    fsyncDirectoryChain(stagingHome, dirname(target));
  }
  fsyncDirectory(stagingHome);
}

function copyManagedRuntimeHome(
  sourceHome: string,
  stagingHome: string
): void {
  assertRuntimeHomeTreeSafe(sourceHome);
  cpSync(sourceHome, stagingHome, {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
    filter: source => !isTransientRuntimeHomePath(sourceHome, source)
  });
  fsyncDirectory(dirname(stagingHome));
}

const TRANSIENT_RUNTIME_HOME_DIRECTORIES = new Set(['.tmp', 'tmp']);

function assertRuntimeHomeTreeSafe(
  root: string,
  current: string = root
): void {
  const info = lstatSync(current);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw migrationError(
      'CODEX_RUNTIME_MIGRATION_SOURCE_CORRUPT',
      'source Runtime Home must be a regular directory'
    );
  }
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (isTransientRuntimeHomePath(root, path)) continue;
    const entryInfo = lstatSync(path);
    if (entryInfo.isSymbolicLink()) {
      throw migrationError(
        'CODEX_RUNTIME_MIGRATION_SOURCE_CORRUPT',
        `source Runtime Home contains a symbolic link: ${path}`
      );
    }
    if (entryInfo.isDirectory()) {
      assertRuntimeHomeTreeSafe(root, path);
      continue;
    }
    if (!entryInfo.isFile()) {
      throw migrationError(
        'CODEX_RUNTIME_MIGRATION_SOURCE_CORRUPT',
        `source Runtime Home contains an unsupported entry: ${path}`
      );
    }
  }
}

function isTransientRuntimeHomePath(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  if (relativePath.length === 0) return false;
  const [topLevelEntry] = relativePath.split(sep);
  return TRANSIENT_RUNTIME_HOME_DIRECTORIES.has(topLevelEntry!);
}

function mergeManifestFiles(
  stagingHome: string,
  targetHome: string,
  manifest: CodexRuntimeMigrationManifest
): void {
  verifyTargetDirectory(targetHome);
  for (const relativePath of manifestRelativePaths(manifest)) {
    const expected = expectedFingerprint(manifest, relativePath);
    const target = targetPathForRuntimeFile(targetHome, relativePath);
    if (existsSync(target)) {
      verifyTargetFingerprint(targetHome, relativePath, expected);
      continue;
    }
    const source = targetPathForRuntimeFile(stagingHome, relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = join(
      dirname(target),
      `.${basename(target)}.${manifest.sourceManifestSha256}.tmp`
    );
    rmSync(temporary, { force: true });
    copyFileSync(source, temporary);
    fsyncFile(temporary);
    if (existsSync(target)) {
      rmSync(temporary, { force: true });
      verifyTargetFingerprint(targetHome, relativePath, expected);
      continue;
    }
    renameSync(temporary, target);
    fsyncDirectoryChain(targetHome, dirname(target));
  }
  fsyncDirectory(targetHome);
}

function verifySourceFiles(
  sourceHome: string,
  manifest: CodexRuntimeMigrationManifest
): void {
  for (const thread of manifest.threads) {
    if (!thread.recoverableBeforeMigration) continue;
    const source = inspectCodexRuntimeRolloutFileV0146(
      sourceHome,
      thread.sourceRelativePath!
    );
    if (
      source.size !== thread.sourceSize
      || source.mtimeMs !== thread.sourceMtimeMs
      || source.sha256 !== thread.sourceSha256
      || source.codexThreadId !== thread.codexThreadId
    ) {
      throw migrationError(
        'CODEX_RUNTIME_MIGRATION_SOURCE_CHANGED',
        `source rollout changed: ${thread.sourceRelativePath}`
      );
    }
    for (const companion of thread.companionFiles) {
      const inspected = inspectCodexRuntimeRolloutFileV0146(
        sourceHome,
        companion.relativePath
      );
      if (
        inspected.size !== companion.size
        || inspected.sha256 !== companion.sha256
      ) {
        throw migrationError(
          'CODEX_RUNTIME_MIGRATION_SOURCE_CHANGED',
          `source companion changed: ${companion.relativePath}`
        );
      }
    }
  }
}

function verifyTargetFiles(
  targetHome: string,
  manifest: CodexRuntimeMigrationManifest
): void {
  verifyTargetDirectory(targetHome);
  for (const relativePath of manifestRelativePaths(manifest)) {
    const expected = expectedFingerprint(manifest, relativePath);
    verifyTargetFingerprint(targetHome, relativePath, expected);
  }
}

function verifyTargetFingerprint(
  targetHome: string,
  relativePath: string,
  expected: { size: number; sha256: string }
): void {
  const actual = inspectCodexRuntimeRolloutFileV0146(targetHome, relativePath);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw migrationError(
      'CODEX_RUNTIME_MIGRATION_TARGET_INVALID',
      `target rollout hash mismatch: ${relativePath}`
    );
  }
}

function verifyTargetDirectory(targetHome: string): void {
  if (!existsSync(targetHome) || !statSync(targetHome).isDirectory()) {
    throw migrationError(
      'CODEX_RUNTIME_MIGRATION_TARGET_INVALID',
      'target Runtime Home is missing'
    );
  }
}

function rebuildTargetSessionIndex(
  targetHome: string,
  manifest: CodexRuntimeMigrationManifest
): void {
  const database = openRuntimeDatabase(':memory:');
  try {
    const repository = createCodexSessionIndexRepository(database);
    createCodexSessionIndexer({
      codexHome: targetHome,
      repository,
      collections: ['sessions', 'archived_sessions']
    }).sync();
    for (const thread of manifest.threads) {
      if (!thread.recoverableBeforeMigration) continue;
      const source = repository.getSessionSource(thread.codexThreadId);
      if (
        source === undefined
        || source.last_error !== null
        || source.parsed_offset !== source.file_size
      ) {
        throw migrationError(
          'CODEX_RUNTIME_MIGRATION_TARGET_INVALID',
          `target Session Index cannot fully parse thread ${thread.codexThreadId}`
        );
      }
    }
  } finally {
    database.close();
  }
}

async function verifyStagingHomeWithAppServer(input: {
  codexBin: string;
  stagingHome: string;
  manifest: CodexRuntimeMigrationManifest;
  requestTimeoutMs?: number;
  createClient?: typeof createCodexAppServerClient;
}): Promise<void> {
  const verificationHome = join(
    dirname(input.stagingHome),
    `.verification-${input.manifest.sourceManifestSha256}`
  );
  removeMigrationDirectory(verificationHome);
  try {
    mkdirSync(verificationHome, { recursive: true, mode: 0o700 });
    copyManifestFiles(input.stagingHome, verificationHome, input.manifest);
    verifyTargetFiles(verificationHome, input.manifest);
    rebuildTargetSessionIndex(verificationHome, input.manifest);
    await verifyThreadsWithAppServer({
      codexBin: input.codexBin,
      codexHome: verificationHome,
      threads: input.manifest.threads,
      requestTimeoutMs: input.requestTimeoutMs,
      createClient: input.createClient
    });
    verifyTargetFiles(verificationHome, input.manifest);
  } finally {
    removeMigrationDirectory(verificationHome);
  }
}

function removeMigrationDirectory(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 10 : 0,
    retryDelay: 100
  });
}

async function verifyThreadsWithAppServer(input: {
  codexBin: string;
  codexHome: string;
  threads: CodexRuntimeMigrationThread[];
  requestTimeoutMs?: number;
  createClient?: typeof createCodexAppServerClient;
}): Promise<void> {
  const createClient = input.createClient ?? createCodexAppServerClient;
  const clientInput: CreateCodexAppServerClientInput = {
    codexBin: input.codexBin,
    codexHome: input.codexHome,
    ...(input.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: input.requestTimeoutMs })
  };
  const client = createClient(clientInput);
  try {
    for (const thread of input.threads) {
      if (!thread.recoverableBeforeMigration) continue;
      const response = await client.request<unknown>('thread/read', {
        threadId: thread.codexThreadId,
        includeTurns: true
      });
      if (
        !isRecord(response)
        || !isRecord(response.thread)
        || response.thread.id !== thread.codexThreadId
        || !Array.isArray(response.thread.turns)
      ) {
        throw migrationError(
          'CODEX_RUNTIME_MIGRATION_VERIFICATION_FAILED',
          `thread/read returned an invalid thread for ${thread.codexThreadId}`
        );
      }
    }
  } finally {
    await client.close();
  }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(
    path,
    runtimeMigrationSyncOpenMode(process.platform)
  );
  try {
    flushRuntimeFileDescriptor(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function runtimeMigrationSyncOpenMode(
  platform: NodeJS.Platform
): 'r' | 'r+' {
  return platform === 'win32' ? 'r+' : 'r';
}

function fsyncDirectoryChain(root: string, leaf: string): void {
  let current = resolve(leaf);
  const boundary = resolve(root);
  while (current.startsWith(`${boundary}${sep}`)) {
    fsyncDirectory(current);
    current = dirname(current);
  }
  fsyncDirectory(boundary);
}

function manifestRelativePaths(
  manifest: CodexRuntimeMigrationManifest
): string[] {
  const paths = new Set<string>();
  for (const thread of manifest.threads) {
    if (thread.sourceRelativePath !== null) paths.add(thread.sourceRelativePath);
    for (const companion of thread.companionFiles) {
      paths.add(companion.relativePath);
    }
  }
  return [...paths].sort();
}

function expectedFingerprint(
  manifest: CodexRuntimeMigrationManifest,
  relativePath: string
): { size: number; sha256: string } {
  for (const thread of manifest.threads) {
    if (thread.sourceRelativePath === relativePath) {
      return { size: thread.sourceSize!, sha256: thread.sourceSha256! };
    }
    const companion = thread.companionFiles.find(
      file => file.relativePath === relativePath
    );
    if (companion !== undefined) return companion;
  }
  throw migrationError(
    'CODEX_RUNTIME_MIGRATION_TARGET_INVALID',
    `manifest does not contain ${relativePath}`
  );
}

function migrationResult(
  status: 'activated' | 'already_activated',
  journal: ParsedCodexRuntimeMigrationJournal
): CodexHomeMigrationResult {
  return {
    status,
    sourceManifestSha256: journal.manifest.sourceManifestSha256,
    journalPath: journal.path,
    migratedThreadIds: journal.manifest.threads
      .filter(thread => thread.recoverableBeforeMigration)
      .map(thread => thread.codexThreadId)
  };
}

function normalizeMigrationError(
  error: unknown,
  fallback: CodexHomeMigrationErrorCode
): CodexHomeMigrationError {
  return error instanceof CodexHomeMigrationError
    ? error
    : migrationError(
        fallback,
        error instanceof Error ? error.message : String(error)
      );
}

function asMigrationErrorCode(value: string | null): CodexHomeMigrationErrorCode {
  return value === null
    ? 'CODEX_RUNTIME_MIGRATION_FAILED'
    : value as CodexHomeMigrationErrorCode;
}

function migrationError(
  code: CodexHomeMigrationErrorCode,
  message: string
): CodexHomeMigrationError {
  return new CodexHomeMigrationError(code, message);
}

function pathInside(root: string, path: string): boolean {
  const normalizedRoot = `${resolve(root)}${sep}`;
  const normalizedPath = resolve(path);
  return normalizedPath === resolve(root) || normalizedPath.startsWith(normalizedRoot);
}

function nowIso(now: (() => Date) | undefined): string {
  return (now?.() ?? new Date()).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
