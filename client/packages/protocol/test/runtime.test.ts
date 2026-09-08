import { describe, expect, it } from 'vitest';
import {
  compareSemanticVersions,
  parseCodexRuntimeCommitMarker,
  parseCodexRuntimeLaunchContext,
  parseCodexRuntimeLaunchContextJson,
  parsePersistedCodexRuntimeState
} from '../src/runtime.js';

const descriptor = {
  runtimeId: 'codex-rust-v0.146.0-layout-1',
  source: 'embedded-package',
  codexVersion: '0.146.0',
  releaseTag: 'rust-v0.146.0',
  target: 'aarch64-apple-darwin',
  layoutVersion: 1,
  entryPath: '/Applications/Clawee.app/Contents/Resources/codex-runtime/bin/codex',
  homePath: '/Users/test/Library/Application Support/Clawee/codex/homes/codex-rust-v0.146.0-layout-1',
  contentSha256: 'a'.repeat(64),
  minimumClaweeVersion: '1.0.0',
  migrationSourceHome: '/Users/test/.codex'
} as const;

describe('Codex Runtime protocol', () => {
  it('parses a complete launch context without rewriting it', () => {
    const context = {
      candidate: descriptor,
      previous: null,
      claweeVersion: '1.0.0'
    };

    expect(parseCodexRuntimeLaunchContext(context)).toEqual(context);
    expect(parseCodexRuntimeLaunchContextJson(JSON.stringify(context)))
      .toEqual(context);
  });

  it('rejects relative paths, malformed hashes and invalid previous sources', () => {
    for (const context of [
      {
        candidate: { ...descriptor, entryPath: 'bin/codex' },
        previous: null,
        claweeVersion: '1.0.0'
      },
      {
        candidate: { ...descriptor, contentSha256: 'pending' },
        previous: null,
        claweeVersion: '1.0.0'
      },
      {
        candidate: descriptor,
        previous: descriptor,
        claweeVersion: '1.0.0'
      }
    ]) {
      expect(() => parseCodexRuntimeLaunchContext(context)).toThrow(
        /Codex Runtime/i
      );
    }
  });

  it('parses persisted activation state and commit markers strictly', () => {
    const previous = {
      ...descriptor,
      source: 'embedded-rollback-cache',
      entryPath: '/tmp/rollback/runtime/bin/codex'
    } as const;
    const state = {
      schemaVersion: 1,
      state: 'active_uncommitted',
      active: descriptor,
      previous,
      migrationManifestSha256: 'b'.repeat(64),
      updatedAt: '2026-08-21T08:00:00.000Z'
    } as const;
    const marker = {
      schemaVersion: 1,
      runtimeId: previous.runtimeId,
      homePath: previous.homePath,
      minimumClaweeVersion: previous.minimumClaweeVersion,
      committedAt: '2026-08-21T07:00:00.000Z'
    } as const;

    expect(parsePersistedCodexRuntimeState(state)).toEqual(state);
    expect(parseCodexRuntimeCommitMarker(marker)).toEqual(marker);
    expect(() => parsePersistedCodexRuntimeState({
      ...state,
      migrationManifestSha256: 'partial'
    })).toThrow(/Codex Runtime/i);
    expect(() => parseCodexRuntimeCommitMarker({
      ...marker,
      committedAt: 'not-a-date'
    })).toThrow(/Codex Runtime/i);
  });

  it('compares release and prerelease SemVer values', () => {
    expect(compareSemanticVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemanticVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareSemanticVersions('2.0.0', '10.0.0')).toBe(-1);
    expect(compareSemanticVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(compareSemanticVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
  });
});
