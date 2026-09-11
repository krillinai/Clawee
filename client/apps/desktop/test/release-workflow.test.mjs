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
const serverCiWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/server-ci.yml'),
  'utf8'
);
const sourceSecurityWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/source-security.yml'),
  'utf8'
);

describe('Release workflows', () => {
  it('keeps ordinary CI manual and automatic workflows off branches', () => {
    for (const workflow of [ciWorkflow, serverCiWorkflow]) {
      expect(workflow).toContain('workflow_dispatch:');
      expect(workflow).not.toMatch(/\n  push:/);
      expect(workflow).not.toContain('pull_request:');
      expect(workflow).not.toContain('branches:');
    }
    expect(sourceSecurityWorkflow).toContain('workflow_dispatch:');
    expect(sourceSecurityWorkflow).toContain("tags:\n      - 'v*'");
    expect(sourceSecurityWorkflow).not.toContain('pull_request:');
    expect(sourceSecurityWorkflow).not.toContain('branches:');
  });

  it('runs client, server, package, container and unsigned Desktop preflight for an explicit ref', () => {
    expect(preflightWorkflow).toContain('workflow_call:');
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
    expect(preflightWorkflow).toContain(
      'permissions:\n  contents: read\n\nconcurrency:'
    );
    expect(preflightWorkflow).toContain(
      'client:\n    permissions:\n      contents: read\n      statuses: write'
    );
    expect(preflightWorkflow).toContain('context=release-preflight');
    expect(preflightWorkflow).toContain(
      '"repos/${GITHUB_REPOSITORY}/statuses/${TARGET_SHA}"'
    );
    for (const result of [
      'CLIENT_RESULT',
      'SERVER_RESULT',
      'DESKTOP_RESULT',
      'SERVER_PACKAGE_RESULT',
      'CONTAINER_RESULT',
      'COS_PREFLIGHT_RESULT'
    ]) {
      expect(preflightWorkflow).toContain(result);
    }
  });

  it('runs reusable preflight before gating version tags and unified version', () => {
    expect(releaseWorkflow).toContain("- 'v*'");
    expect(releaseWorkflow).not.toContain('workflow_dispatch:');
    expect(releaseWorkflow).toContain(
      'uses: ./.github/workflows/release-preflight.yml'
    );
    expect(releaseWorkflow).toContain('ref: ${{ github.sha }}');
    expect(releaseWorkflow).toContain('statuses: write');
    expect(releaseWorkflow).toContain('gate:\n    needs: preflight');
    expect(releaseWorkflow).toContain(
      'node scripts/release-version.mjs check'
    );
    expect(releaseWorkflow).not.toContain(
      'select(.context == "release-preflight")'
    );
    expect(releaseWorkflow).not.toContain('secrets: inherit');
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

  it('centralizes COS credentials and publishes immutable objects before channel pointers', () => {
    expect((releaseWorkflow.match(/secrets\.TENCENT_CLOUD_SECRET_ID/g) ?? [])).toHaveLength(1);
    expect((releaseWorkflow.match(/secrets\.TENCENT_CLOUD_SECRET_KEY/g) ?? [])).toHaveLength(1);
    expect((preflightWorkflow.match(/secrets\.TENCENT_CLOUD_SECRET_ID/g) ?? [])).toHaveLength(1);
    expect((preflightWorkflow.match(/secrets\.TENCENT_CLOUD_SECRET_KEY/g) ?? [])).toHaveLength(1);
    expect(releaseWorkflow).toContain('group: cos-production-release');
    expect(releaseWorkflow.indexOf('release-immutable')).toBeLessThan(
      releaseWorkflow.indexOf('公开 GitHub Release')
    );
    expect(releaseWorkflow.indexOf('公开 GitHub Release')).toBeLessThan(
      releaseWorkflow.indexOf('release-promote')
    );
    expect(preflightWorkflow).toContain('cos-preflight-upload:');
    expect(preflightWorkflow).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(preflightWorkflow).toContain('publisher/scripts/cos-publish.mjs preflight');
  });

  it('reuses published GitHub Release assets for COS-only promotion retries', () => {
    expect(releaseWorkflow).toContain(
      'release_published: ${{ steps.release_state.outputs.published }}'
    );
    expect(releaseWorkflow).toContain(
      "if: needs.gate.outputs.release_published != 'true'"
    );
    expect(releaseWorkflow).toContain("if: env.RELEASE_ALREADY_PUBLISHED == 'true'");
    expect(releaseWorkflow).toContain("gh release download \"$TAG\" --pattern 'release.json'");
    expect(releaseWorkflow).toContain("gh release download \"$TAG\" --pattern 'latest*.yml'");
    expect(releaseWorkflow).toContain('args+=(--verify-immutable)');
    for (const step of [
      '生成统一发布清单',
      '生成 COS 版本目录和官网目录文件',
      '上传并验证 COS 不可变版本目录',
      '发布版本镜像标签'
    ]) {
      const start = releaseWorkflow.indexOf(`- name: ${step}`);
      expect(releaseWorkflow.slice(start, start + 180)).toContain(
        "if: env.RELEASE_ALREADY_PUBLISHED != 'true'"
      );
    }
  });

  it('bootstraps an empty COS channel before exposing the migration release', () => {
    expect(releaseWorkflow.indexOf('release-bootstrap')).toBeLessThan(
      releaseWorkflow.indexOf('公开 GitHub Release')
    );
    expect(releaseWorkflow).toContain('--version "$VERSION"');
    expect(releaseWorkflow).toContain('--commit "$GITHUB_SHA"');
  });
});
