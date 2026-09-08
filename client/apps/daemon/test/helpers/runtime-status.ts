import type { CodexRuntimeStatus } from '@clawee/protocol';

export function createTestCodexRuntimeStatus(
  overrides: Partial<CodexRuntimeStatus> = {}
): CodexRuntimeStatus {
  return {
    runtimeId: 'codex-rust-v0.146.0-layout-1',
    source: 'embedded-package',
    version: '0.146.0',
    releaseTag: 'rust-v0.146.0',
    target: 'aarch64-apple-darwin',
    layoutVersion: 1,
    entryPath: '/Applications/Clawee.app/Contents/Resources/codex-runtime/bin/codex',
    homePath: '/Users/test/Library/Application Support/Clawee/codex/homes/codex-rust-v0.146.0-layout-1',
    contentSha256: 'a'.repeat(64),
    activationState: 'committed',
    minimumClaweeVersion: '1.0.0',
    committedAt: '2026-08-21T08:00:00.000Z',
    ...overrides
  };
}
