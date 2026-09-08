export type CodexHomeMigrationPhase =
  | 'manifest'
  | 'files_copied'
  | 'copied'
  | 'verified'
  | 'activated';

export type CodexRuntimeMigrationThread = {
  claweeThreadId: string;
  codexThreadId: string;
  recoverableBeforeMigration: boolean;
  sourceRelativePath: string | null;
  sourceSize: number | null;
  sourceMtimeMs: number | null;
  sourceSha256: string | null;
  companionFiles: Array<{
    relativePath: string;
    size: number;
    sha256: string;
  }>;
  copyStatus: 'pending' | 'copied' | 'not_recoverable' | 'failed';
  verificationStatus: 'pending' | 'verified' | 'not_applicable' | 'failed';
  errorCode: string | null;
};

export type CodexHomeMigrationResult = {
  status: 'not_required' | 'activated' | 'already_activated';
  sourceManifestSha256: string | null;
  journalPath: string;
  migratedThreadIds: string[];
};

export type CodexHomeMigrationErrorCode =
  | 'CODEX_RUNTIME_MIGRATION_LAYOUT_UNSUPPORTED'
  | 'CODEX_RUNTIME_MIGRATION_SOURCE_MISSING'
  | 'CODEX_RUNTIME_MIGRATION_SOURCE_DUPLICATE'
  | 'CODEX_RUNTIME_MIGRATION_SOURCE_CORRUPT'
  | 'CODEX_RUNTIME_MIGRATION_SOURCE_CHANGED'
  | 'CODEX_RUNTIME_MIGRATION_PAGINATED_UNSUPPORTED'
  | 'CODEX_RUNTIME_MIGRATION_TARGET_EXISTS'
  | 'CODEX_RUNTIME_MIGRATION_TARGET_INVALID'
  | 'CODEX_RUNTIME_MIGRATION_VERIFICATION_FAILED'
  | 'CODEX_RUNTIME_MIGRATION_JOURNAL_CORRUPT'
  | 'CODEX_RUNTIME_MIGRATION_FAILED';

export class CodexHomeMigrationError extends Error {
  constructor(
    readonly code: CodexHomeMigrationErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'CodexHomeMigrationError';
  }
}

export type CodexRuntimeMigrationState =
  | 'planned'
  | 'copied'
  | 'verified'
  | 'activated'
  | 'failed';

export type CodexRuntimeMigrationManifest = {
  type: 'manifest';
  schemaVersion: 1;
  runtimeId: string;
  sourceManifestSha256: string;
  sourceHome: string;
  targetHome: string;
  threads: CodexRuntimeMigrationThread[];
  createdAt: string;
};

export type CodexRuntimeMigrationJournalRecord =
  | CodexRuntimeMigrationManifest
  | {
      type: 'transition';
      from: CodexRuntimeMigrationState;
      to: Exclude<CodexRuntimeMigrationState, 'planned'>;
      at: string;
      errorCode: string | null;
    };

export type ParsedCodexRuntimeMigrationJournal = {
  path: string;
  manifest: CodexRuntimeMigrationManifest;
  state: CodexRuntimeMigrationState;
};
