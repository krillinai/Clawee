import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const releaseWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/release.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const preflightWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/release-preflight.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const serverReleaseWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/server-release.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const ciWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/ci.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const serverCiWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/server-ci.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const sourceSecurityWorkflow = readFileSync(
  resolve(process.cwd(), '../../../.github/workflows/source-security.yml'),
  'utf8'
).replace(/\r\n/g, '\n');

const shell = (() => {
  if (process.platform !== 'win32') return 'bash';
  const gitExecPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  const candidates = [
    resolve(gitExecPath, '..', '..', '..', 'usr', 'bin', 'bash.exe'),
    resolve(gitExecPath, '..', '..', '..', 'bin', 'bash.exe')
  ];
  const gitBash = candidates.find(candidate => existsSync(candidate));
  if (!gitBash) throw new Error('找不到 Git Bash，无法执行发布工作流脚本测试');
  return gitBash;
})();

describe('Release workflows', () => {
  it('defaults to source-only preflight and keeps candidate packaging opt-in', () => {
    const definition = yaml.load(preflightWorkflow);
    for (const trigger of ['workflow_call', 'workflow_dispatch']) {
      expect(definition.on[trigger].inputs.build_candidates).toMatchObject({
        type: 'boolean', default: false
      });
    }
    for (const job of ['desktop', 'server-package', 'container', 'cos-preflight-upload']) {
      expect(definition.jobs[job].if).toBe('inputs.build_candidates');
    }
    expect(definition.jobs.client.if).toBeUndefined();
    expect(definition.jobs.server.if).toBe('inputs.build_candidates');
    const release = yaml.load(releaseWorkflow);
    expect(release.jobs.preflight.with.build_candidates).toBe(false);
    expect(release.jobs.preflight.secrets).toBeUndefined();
  });

  it('fails closed when recording preflight results in either mode', () => {
    const definition = yaml.load(preflightWorkflow);
    const script = definition.jobs.record.steps[0].run;
    const candidateResults = ['DESKTOP_RESULT', 'SERVER_PACKAGE_RESULT', 'CONTAINER_RESULT', 'COS_PREFLIGHT_RESULT'];
    const execute = (buildCandidates, overrides = {}) => spawnSync(shell, ['-c', `gh() { return 0; }\n${script}`], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'krillinai/Clawee', TARGET_SHA: 'a'.repeat(40),
        BUILD_CANDIDATES: String(buildCandidates), CLIENT_RESULT: 'success',
        SERVER_RESULT: buildCandidates ? 'success' : 'skipped',
        ...Object.fromEntries(candidateResults.map(name => [name, buildCandidates ? 'success' : 'skipped'])),
        ...overrides
      }
    }).status;
    for (const mode of [false, true]) {
      expect(execute(mode)).toBe(0);
      for (const name of ['CLIENT_RESULT', 'SERVER_RESULT', ...candidateResults]) {
        for (const result of ['failure', 'cancelled']) {
          expect(execute(mode, { [name]: result })).not.toBe(0);
        }
      }
    }
    expect(execute(true, { DESKTOP_RESULT: 'skipped' })).not.toBe(0);
    expect(execute(false, { DESKTOP_RESULT: 'success' })).not.toBe(0);
    expect(execute(false, { SERVER_RESULT: 'success' })).not.toBe(0);
  });

  it('preserves disabled image builds and deployment smoke without blocking desktop publishing', () => {
    const definition = yaml.load(releaseWorkflow);
    const steps = definition.jobs.image.steps;
    const buildIndex = steps.findIndex(step => step.id === 'build');
    const smokeIndex = steps.findIndex(step => step.run === 'node scripts/container-smoke.mjs');
    expect(smokeIndex).toBeGreaterThan(buildIndex);
    expect(steps[smokeIndex].env.CLAWEE_TEST_IMAGE).toBe(
      '${{ steps.image.outputs.name }}@${{ steps.build.outputs.digest }}'
    );
    expect(steps[smokeIndex]['continue-on-error']).toBeUndefined();
    expect(steps.some(step => step.run === 'pnpm --dir client install --frozen-lockfile')).toBe(true);
    expect(definition.jobs.image.if).toBe('${{ false }}');
    expect(definition.jobs.publish.if).not.toContain('needs.image');
  });

  it('keeps dependency audits advisory without relaxing other steps', () => {
    for (const [workflow, auditCount] of [
      [ciWorkflow, 1],
      [serverCiWorkflow, 1],
      [preflightWorkflow, 2]
    ]) {
      const steps = workflow.split(/\n(?=      - )/);
      const auditSteps = steps.filter(step =>
        /run: pnpm (?:--dir web )?audit --audit-level high/.test(step)
      );
      expect(auditSteps).toHaveLength(auditCount);
      for (const step of auditSteps) {
        expect(step).toContain('continue-on-error: true');
      }
      for (const step of steps.filter(step =>
        step.includes('continue-on-error: true')
      )) {
        expect(auditSteps).toContain(step);
      }
    }
  });

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

  it('keeps full candidate preflight available for an explicit ref', () => {
    expect(preflightWorkflow).toContain('workflow_call:');
    expect(preflightWorkflow).toContain('workflow_dispatch:');
    expect(preflightWorkflow).toContain('description: 要验证的分支、Tag 或 Commit SHA');
    expect(preflightWorkflow).toContain('os: macos-15-intel');
    expect(preflightWorkflow).toContain('os: macos-15');
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
    expect(releaseWorkflow).toContain('workflow_dispatch:');
    expect(releaseWorkflow).toContain(
      'uses: ./.github/workflows/release-preflight.yml'
    );
    expect(releaseWorkflow).toContain('ref: ${{ needs.target.outputs.sha }}');
    expect(releaseWorkflow).toContain(
      'TENCENT_CLOUD_SECRET_ID: ${{ secrets.TENCENT_CLOUD_SECRET_ID }}'
    );
    expect(releaseWorkflow).toContain(
      'TENCENT_CLOUD_SECRET_KEY: ${{ secrets.TENCENT_CLOUD_SECRET_KEY }}'
    );
    expect(releaseWorkflow).toContain('statuses: write');
    expect(releaseWorkflow).toContain('gate:\n    needs: [target, preflight, reuse]');
    expect(releaseWorkflow).toContain(
      'node scripts/release-version.mjs check'
    );
    expect(releaseWorkflow).not.toContain(
      'select(.context == "release-preflight")'
    );
    expect(releaseWorkflow).not.toContain('secrets: inherit');
  });

  it('pins packages to the existing tag while using current release tooling for retries', () => {
    expect(releaseWorkflow).toContain('ref: refs/tags/${{ inputs.tag || github.ref_name }}');
    expect(releaseWorkflow).toContain('echo "sha=$(git rev-parse HEAD)"');
    expect(releaseWorkflow).toContain('SOURCE_SHA: ${{ needs.gate.outputs.sha }}');
    expect(releaseWorkflow).toContain('TAG: ${{ needs.gate.outputs.tag }}');
    expect(releaseWorkflow).not.toContain('$GITHUB_SHA');
    expect(releaseWorkflow).toContain('path: release-tools');
    expect(releaseWorkflow).not.toMatch(/git (?:tag|push)/);
    expect((releaseWorkflow.match(/ref: \$\{\{ needs\.gate\.outputs\.sha \}\}/g) ?? []))
      .toHaveLength(3);
    const publishCheckout = yaml.load(releaseWorkflow).jobs.publish.steps[0];
    expect(publishCheckout.with.ref).toBe('${{ github.sha }}');
    expect(publishCheckout.with['fetch-depth']).toBeUndefined();
    expect(yaml.load(releaseWorkflow).jobs.publish.env.GENERATED_AT)
      .toBe('${{ needs.gate.outputs.generated-at }}');
    expect(serverReleaseWorkflow).toContain('ref: ${{ inputs.ref || github.sha }}');
    expect(serverReleaseWorkflow).toContain('RELEASE_TAG: ${{ inputs.tag || github.ref_name }}');
    expect(serverReleaseWorkflow).toContain('CLAW_GATEWAY_COMMIT: ${{ inputs.ref || github.sha }}');
  });

  it('reuses only verified prior Release artifacts without repeating signed builds', () => {
    expect(releaseWorkflow).toContain('node scripts/verify-release-reuse.mjs run');
    expect(releaseWorkflow).toContain("needs.reuse.result == 'success'");
    expect(releaseWorkflow).toContain('run-id: ${{ inputs.artifacts_run_id || github.run_id }}');
    expect(releaseWorkflow).toContain('github-token: ${{ github.token }}');
    expect(releaseWorkflow).toContain('node release-tools/scripts/verify-release-reuse.mjs artifacts');
    expect((releaseWorkflow.match(/inputs.artifacts_run_id == ''/g) ?? [])).toHaveLength(3);
    const definition = yaml.load(releaseWorkflow);
    for (const job of ['reuse', 'publish']) {
      const steps = definition.jobs[job].steps;
      for (const step of steps.filter(step => step.run?.includes('scripts/verify-release-reuse.mjs'))) {
        expect(step.run).toContain('--desktop-only');
      }
      expect(steps.find(step => step.uses === 'actions/download-artifact@v4').with.pattern)
        .toBe('clawee-desktop-release-*');
    }
    expect(releaseWorkflow).toContain('actions: read');
  });

  it('separates notary recovery inputs, retained evidence and publishable artifacts', () => {
    const definition = yaml.load(releaseWorkflow);
    expect(definition.on.workflow_dispatch.inputs.notary_run_id.type).toBe('string');
    const targetValidation = definition.jobs.target.steps[0].run;
    expect(targetValidation).toContain('[[ -z "$ARTIFACTS_RUN_ID" || -z "$NOTARY_RUN_ID" ]]');
    const steps = definition.jobs.desktop.steps;
    expect(definition.jobs.desktop.permissions.actions).toBe('read');
    const source = steps.find(step => step.id === 'notary_source');
    expect(source.run).toContain('verify-notary-recovery-run.mjs');
    expect(source['continue-on-error']).toBeUndefined();
    const recoveryDownload = steps.find(step => step.name === '下载原 macOS 公证检查点和验证上下文');
    expect(recoveryDownload.with.name).toBe('clawee-desktop-notary-${{ matrix.name }}');
    expect(recoveryDownload.with['run-id']).toBe('${{ inputs.notary_run_id }}');
    const resume = steps.find(step => step.run === 'pnpm desktop:notary:resume');
    expect(resume.env.CLAWEE_NOTARY_SOURCE_RUN_ATTEMPT).toBe('${{ steps.notary_source.outputs.run-attempt }}');
    expect(steps.indexOf(source)).toBeLessThan(steps.indexOf(recoveryDownload));
    expect(steps.indexOf(recoveryDownload)).toBeLessThan(steps.indexOf(resume));
    expect(steps.find(step => step.run === 'pnpm desktop:release').if).toContain("inputs.notary_run_id == ''");
    expect(steps.find(step => step.run === 'pnpm desktop:dist').if).toContain("inputs.notary_run_id == ''");
    const retention = steps.find(step => step.uses === 'actions/upload-artifact@v4'
      && step.with?.name === 'clawee-desktop-notary-${{ matrix.name }}');
    expect(retention.if).toBe("always() && matrix.platform == 'mac'");
    expect(retention.with.path).toBe('client/apps/desktop/release/notary-recovery');
    expect(retention.with['retention-days']).toBe(14);
    const releaseUpload = steps.find(step => step.with?.name === 'clawee-desktop-release-${{ matrix.name }}');
    expect(releaseUpload.if).toBeUndefined();
    expect(releaseUpload.with.path).not.toContain('notary-recovery');
    expect(definition.jobs.publish.steps.find(step => step.uses === 'actions/download-artifact@v4').with.pattern)
      .toBe('clawee-desktop-release-*');
    expect(definition.jobs.gate.steps.find(step => step.name === '验证 macOS 正式签名凭据').run)
      .toContain('if [[ -z "$NOTARY_RUN_ID" ]]');
  });

  it('creates signed macOS and explicitly unsigned Windows release packages', () => {
    expect(releaseWorkflow).toContain('os: macos-15-intel');
    expect(releaseWorkflow).toContain('os: macos-15');
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

  it('pauses release E2E without removing candidate checks or package uploads', () => {
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
      for (const name of ['验证包内 Codex Runtime E2E', '验证包内 Codex 真实会话']) {
        const step = yaml.load(workflow).jobs.desktop.steps.find(step => step.name === name);
        expect(step.if).toBe(workflow === releaseWorkflow
          ? '${{ false }}'
          : "matrix.platform != 'win'");
      }
      expect(workflow).toContain('apps/desktop/release/*.dmg');
      expect(workflow).toContain('apps/desktop/release/*.exe');
      expect(workflow).toContain('if-no-files-found: error');
    }
    const steps = yaml.load(releaseWorkflow).jobs.desktop.steps;
    expect(steps.find(step => step.name === '上传 Runtime E2E 证据').if).toBe('${{ false }}');
    const packageUpload = steps.find(step => step.with?.name === 'clawee-desktop-release-${{ matrix.name }}');
    expect(packageUpload.if).toBeUndefined();
    expect(packageUpload.with['if-no-files-found']).toBe('error');
  });

  it('builds after a successful gate despite skipped optional preflight or reuse branches', () => {
    const definition = yaml.load(releaseWorkflow);
    for (const name of ['desktop']) {
      const job = definition.jobs[name];
      expect(job.needs).toBe('gate');
      expect(job.if).toBe(
        "!cancelled() && needs.gate.result == 'success' && "
        + "needs.gate.outputs.release_published != 'true' && inputs.artifacts_run_id == ''"
      );
    }
  });

  it('keeps server and image jobs disabled and publishes only complete desktop builds', () => {
    const definition = yaml.load(releaseWorkflow);
    expect(definition.jobs.image.needs).toBe('gate');
    expect(definition.jobs.image.if).toBe('${{ false }}');
    expect(definition.jobs.server.if).toBe('${{ false }}');
    expect(definition.jobs.server.uses).toBe('./.github/workflows/server-release.yml');
    expect(definition.jobs.publish.needs).toEqual(['gate', 'desktop']);
    for (const name of ['gate', 'desktop']) {
      expect(definition.jobs.publish.if).toContain(`needs.${name}.result == 'success'`);
    }
    expect(definition.jobs.publish.if).not.toMatch(/needs\.(?:server|image)/);
    const manifestStep = definition.jobs.publish.steps.find(step => step.name === '生成统一发布清单');
    expect(manifestStep.run).toContain('--desktop-only');
    expect(manifestStep.run).not.toContain('--image');
    expect(definition.jobs.publish.permissions.packages).toBeUndefined();
  });

  it('separates immutable image build from version tag publication', () => {
    expect(releaseWorkflow).toContain(
      'tags: ${{ steps.image.outputs.name }}:sha-${{ needs.gate.outputs.sha }}'
    );
    expect(releaseWorkflow).toContain('docker buildx imagetools create');
    expect(releaseWorkflow).toContain('ghcr.io/${GITHUB_REPOSITORY,,}-server');
    const steps = yaml.load(releaseWorkflow).jobs.publish.steps;
    for (const step of steps.filter(step => step.uses?.startsWith('docker/') || step.name === '发布版本镜像标签')) {
      expect(step.if).toBe('${{ false }}');
    }
    expect(releaseWorkflow).toContain('org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}');
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
    expect(releaseWorkflow).toContain('pattern: clawee-desktop-release-*');
    expect(releaseWorkflow).not.toContain(
      'pattern: clawee-desktop-runtime-e2e-*'
    );
    expect(releaseWorkflow).toContain(
      'node scripts/build-release-manifest.mjs'
    );
    expect(releaseWorkflow).toContain(
      'needs: [gate, desktop]'
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
    const definition = yaml.load(releaseWorkflow);
    for (const job of ['desktop']) {
      expect(definition.jobs[job].if).toContain("needs.gate.outputs.release_published != 'true'");
    }
    expect(releaseWorkflow).toContain("if: env.RELEASE_ALREADY_PUBLISHED == 'true'");
    expect(releaseWorkflow).toContain("gh release download \"$TAG\" --pattern 'release.json'");
    expect(releaseWorkflow).toContain("gh release download \"$TAG\" --pattern 'latest*.yml'");
    expect(releaseWorkflow).toContain('args+=(--verify-immutable)');
    for (const step of [
      '生成统一发布清单',
      '生成 COS 版本目录和官网目录文件',
      '上传并验证 COS 不可变版本目录'
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
    expect(releaseWorkflow).toContain('--commit "$SOURCE_SHA"');
  });
});
