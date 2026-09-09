import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/release.yml'),
  'utf8'
);
const preflightWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/release-preflight.yml'),
  'utf8'
);
const serverReleaseWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/server-release.yml'),
  'utf8'
);
const ciWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/ci.yml'),
  'utf8'
);

describe('Release workflows', () => {
  it('keeps ordinary CI off version tag pushes', () => {
    expect(ciWorkflow).toContain('tags-ignore:');
    expect(ciWorkflow).toContain("- '**'");
  });

  it('runs client, server, package, container and unsigned Desktop preflight for an explicit ref', () => {
    expect(preflightWorkflow).toContain('workflow_dispatch:');
    expect(preflightWorkflow).toContain('description: 要验证的分支、Tag 或 Commit SHA');
    expect(preflightWorkflow).toContain('os: macos-15-intel');
    expect(preflightWorkflow).toContain('os: macos-14');
    expect(preflightWorkflow).toContain('os: windows-latest');
    expect(preflightWorkflow).toContain('run: pnpm desktop:dist');
    expect(preflightWorkflow).not.toContain('run: pnpm desktop:release');
    expect(preflightWorkflow).toContain('server-package:');
    expect(preflightWorkflow).toContain('container:');
    expect(preflightWorkflow).toContain(
      'CLAWEE_TEST_IMAGE=clawee-server:preflight node scripts/container-smoke.mjs'
    );
    expect(preflightWorkflow).not.toContain('发布 GitHub Release');
  });

  it('records unified preflight status against the checked-out commit', () => {
    expect(preflightWorkflow).toContain('statuses: write');
    expect(preflightWorkflow).toContain('context=release-preflight');
    expect(preflightWorkflow).toContain(
      '"repos/${GITHUB_REPOSITORY}/statuses/${TARGET_SHA}"'
    );
    for (const result of [
      'CLIENT_RESULT',
      'SERVER_RESULT',
      'DESKTOP_RESULT',
      'SERVER_PACKAGE_RESULT',
      'CONTAINER_RESULT'
    ]) {
      expect(preflightWorkflow).toContain(result);
    }
  });

  it('gates version tags on the same commit preflight result and unified version', () => {
    expect(releaseWorkflow).toContain("- 'v*'");
    expect(releaseWorkflow).not.toContain('workflow_dispatch:');
    expect(releaseWorkflow).toContain('statuses: read');
    expect(releaseWorkflow).toContain(
      'node scripts/release-version.mjs check'
    );
    expect(releaseWorkflow).toContain(
      'select(.context == "release-preflight")'
    );
    expect(releaseWorkflow).toContain(
      '的 Release Preflight 状态为 ${state}，禁止正式发布'
    );
  });

  it('creates signed macOS and explicitly unsigned Windows release packages', () => {
    expect(releaseWorkflow).toContain('os: macos-15-intel');
    expect(releaseWorkflow).toContain('os: macos-14');
    expect(releaseWorkflow).toContain('name: windows-x64-unsigned');
    expect(releaseWorkflow).toContain("if: matrix.platform == 'mac'");
    expect(releaseWorkflow).toContain('run: pnpm desktop:release');
    expect(releaseWorkflow).toContain("if: matrix.platform == 'win'");
    expect(releaseWorkflow).toContain('run: pnpm desktop:dist');
    expect(releaseWorkflow).toContain('secrets.MACOS_CERTIFICATE');
    expect(releaseWorkflow).toContain('secrets.APPLE_ID');
    expect(releaseWorkflow).not.toContain('WIN_CSC_LINK');
    expect(releaseWorkflow).toContain('environment: release');
    expect(releaseWorkflow).toContain('fail-fast: false');
  });

  it('caches the pinned Runtime on preflight and release targets', () => {
    expect(preflightWorkflow).toContain('apps/desktop/.cache/codex-runtime');
    expect(releaseWorkflow).toContain('apps/desktop/.cache/codex-runtime');
    expect(preflightWorkflow).toMatch(
      /hashFiles\([^)]*config\/codex-runtime\.json[^)]*\)/
    );
    expect(releaseWorkflow).toMatch(
      /hashFiles\([^)]*config\/codex-runtime\.json[^)]*\)/
    );
  });

  it('runs packaged Runtime E2E before uploading installers', () => {
    for (const workflow of [preflightWorkflow, releaseWorkflow]) {
      expect(workflow).toContain('name: 验证包内 Codex Runtime E2E');
      expect(workflow).toContain(
        'run: pnpm --filter @clawee/desktop e2e:embedded-runtime'
      );
      expect(workflow).toContain('name: 验证包内 Codex 真实会话');
      expect(workflow).toContain(
        'run: pnpm --filter @clawee/desktop e2e:real-codex'
      );
      expect(workflow).toContain("CLAWEE_RUN_REAL_CODEX_SMOKE: '1'");
      expect(workflow).toContain('apps/desktop/release/*.dmg');
      expect(workflow).toContain('apps/desktop/release/*.exe');
      expect(workflow).toContain('if-no-files-found: error');
    }
  });

  it('separates immutable image build from version tag publication', () => {
    expect(releaseWorkflow).toContain(
      'tags: ghcr.io/krillinai/clawee-server:sha-${{ github.sha }}'
    );
    expect(releaseWorkflow).toContain('docker buildx imagetools create');
    expect(releaseWorkflow).toContain('"${IMAGE}:${VERSION}"');
    expect(releaseWorkflow).toContain('"${IMAGE}:latest"');
    expect(releaseWorkflow).toContain("if [[ \"$PRERELEASE\" == 'false' ]]");
    expect(serverReleaseWorkflow).not.toContain('docker/build-push-action');
  });

  it('keeps prereleases outside the stable updater and latest release channel', () => {
    expect(releaseWorkflow).toContain(
      "CLAWEE_OFFICIAL_RELEASE: ${{ needs.gate.outputs.prerelease == 'false' && '1' || '0' }}"
    );
    expect(releaseWorkflow).toContain('args+=(--prerelease)');
    expect(releaseWorkflow).toContain(
      'gh release edit "$TAG" --draft=false --prerelease'
    );
    expect(releaseWorkflow).toContain(
      'gh release edit "$TAG" --draft=false --latest'
    );
  });

  it('publishes a unified manifest without E2E evidence attachments', () => {
    expect(releaseWorkflow).toContain('pattern: clawee-*-release-*');
    expect(releaseWorkflow).not.toContain(
      'pattern: clawee-desktop-runtime-e2e-*'
    );
    expect(releaseWorkflow).toContain(
      'node scripts/build-release-manifest.mjs'
    );
    expect(releaseWorkflow).toContain(
      'needs: [gate, desktop, server, image]'
    );
    expect(releaseWorkflow).toContain('--draft --verify-tag');
  });
});
