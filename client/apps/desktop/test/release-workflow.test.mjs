import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/desktop-release.yml'),
  'utf8'
);
const preflightWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/desktop-preflight.yml'),
  'utf8'
);
const ciWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/ci.yml'),
  'utf8'
);

describe('Desktop release workflow', () => {
  it('keeps ordinary CI off version tag pushes', () => {
    expect(ciWorkflow).toContain('tags-ignore:');
    expect(ciWorkflow).toContain("- '**'");
  });

  it('runs unsigned three-platform preflight for an explicit ref', () => {
    expect(preflightWorkflow).toContain('workflow_dispatch:');
    expect(preflightWorkflow).toContain('description: 要验证的分支、Tag 或 Commit SHA');
    expect(preflightWorkflow).toContain('os: macos-15-intel');
    expect(preflightWorkflow).toContain('os: macos-14');
    expect(preflightWorkflow).toContain('os: windows-latest');
    expect(preflightWorkflow).toContain('run: pnpm desktop:dist');
    expect(preflightWorkflow).not.toContain('run: pnpm desktop:release');
    expect(preflightWorkflow).not.toContain('发布 GitHub Release');
  });

  it('records preflight status against the checked-out commit', () => {
    expect(preflightWorkflow).toContain('statuses: write');
    expect(preflightWorkflow).toContain('context=desktop-preflight');
    expect(preflightWorkflow).toContain(
      '"repos/${GITHUB_REPOSITORY}/statuses/${TARGET_SHA}"'
    );
    expect(preflightWorkflow).toContain(
      "VERIFY_RESULT: ${{ needs.verify.result }}"
    );
    expect(preflightWorkflow).toContain(
      "PACKAGE_RESULT: ${{ needs.package.result }}"
    );
  });

  it('gates version tags on the same commit preflight result', () => {
    expect(releaseWorkflow).toContain("- 'v*'");
    expect(releaseWorkflow).not.toContain('workflow_dispatch:');
    expect(releaseWorkflow).toContain('statuses: read');
    expect(releaseWorkflow).toContain(
      'select(.context == "desktop-preflight")'
    );
    expect(releaseWorkflow).toContain(
      '的 Desktop Preflight 状态为 ${state}，禁止正式发布'
    );
    expect(releaseWorkflow).toContain('needs: gate');
  });

  it('creates signed macOS and unsigned Windows release packages', () => {
    expect(releaseWorkflow).toContain('os: macos-15-intel');
    expect(releaseWorkflow).toContain('os: macos-14');
    expect(releaseWorkflow).toContain('os: windows-latest');
    expect(releaseWorkflow).toContain("if: matrix.platform == 'mac'");
    expect(releaseWorkflow).toContain('run: pnpm desktop:release');
    expect(releaseWorkflow).toContain("if: matrix.platform == 'win'");
    expect(releaseWorkflow).toContain('run: pnpm desktop:dist');
    expect(releaseWorkflow).toContain('secrets.MACOS_CERTIFICATE');
    expect(releaseWorkflow).toContain('secrets.APPLE_ID');
    expect(releaseWorkflow).not.toContain('secrets.WINDOWS_CERTIFICATE');
    expect(releaseWorkflow).toContain('environment: release');
    expect(releaseWorkflow).toContain('fail-fast: false');
    expect(releaseWorkflow).toContain('name: 验证 macOS 正式签名凭据');
    expect(releaseWorkflow).toContain(
      'release Environment 缺少 macOS 签名 Secret'
    );
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
      expect(workflow).toContain(
        'test-results/clawee-desktop-runtime-tool-loop-e2e.json'
      );
      expect(workflow).toContain('apps/desktop/release/*.dmg');
      expect(workflow).toContain('apps/desktop/release/*.exe');
      expect(workflow).toContain('if-no-files-found: error');
    }
  });

  it('runs dependency security checks during preflight only', () => {
    expect(preflightWorkflow).toContain(
      'run: pnpm audit --audit-level high'
    );
    expect(ciWorkflow).toContain(
      'run: pnpm audit --audit-level high'
    );
    expect(releaseWorkflow).not.toContain('run: pnpm audit');
    expect(preflightWorkflow).not.toContain('osv-scanner-reusable.yml');
    expect(preflightWorkflow).not.toContain('security-events: write');
  });

  it('publishes installer artifacts without E2E evidence attachments', () => {
    expect(releaseWorkflow).toContain(
      'pattern: clawee-*-release-*'
    );
    expect(releaseWorkflow).not.toContain(
      'pattern: clawee-desktop-runtime-e2e-*'
    );
    expect(releaseWorkflow).toContain('needs: [package, server]');
    expect(releaseWorkflow).toContain('--draft --verify-tag');
  });
});
