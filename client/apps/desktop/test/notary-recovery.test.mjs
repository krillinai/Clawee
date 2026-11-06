import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tar from 'tar';
import {
  checkpointFilename, createNotaryRecovery, describeReleaseArtifacts,
  loadNotaryRecovery, notaryFailureDiagnostic, restoreVerificationContext, saveNotaryRecovery
} from '../scripts/notary-recovery.mjs';
import { finalizeReleaseDmgArtifacts } from '../scripts/finalize-macos-release.mjs';
import { resumeMacNotary } from '../scripts/resume-macos-notary.mjs';
import { runStage } from '../scripts/script-utils.mjs';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('../scripts/script-utils.mjs', () => ({ runStage: vi.fn() }));

const submissionId = '73255800-fbcd-4950-a509-fde40d5e39a9';
const expected = {
  repository: 'krillinai/Clawee', runId: '1234', runAttempt: '1',
  sha: 'a'.repeat(40), tag: 'v1.0.12', arch: process.arch === 'arm64' ? 'arm64' : 'x64', teamId: 'TEAM'
};
const directories = [];
const success = { status: 0, stdout: '', stderr: '' };

beforeEach(() => {
  vi.mocked(spawnSync).mockReset();
  vi.mocked(runStage).mockReset();
  vi.stubEnv('GITHUB_REPOSITORY', expected.repository);
  vi.stubEnv('GITHUB_RUN_ID', expected.runId);
  vi.stubEnv('GITHUB_RUN_ATTEMPT', expected.runAttempt);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), 'clawee-notary-recovery-'));
  directories.push(rootDir);
  const releaseDir = join(rootDir, 'apps/desktop/release');
  const directory = join(releaseDir, 'notary-recovery');
  const suffix = expected.arch === 'arm64' ? '-arm64' : '';
  const dmg = join(releaseDir, `Clawee-1.0.12${suffix}.dmg`);
  const zip = join(releaseDir, `Clawee-1.0.12${suffix}-mac.zip`);
  const metadata = join(releaseDir, 'latest-mac.yml');
  const runtime = join(rootDir, 'apps/desktop/.pack/codex-runtime/bin/codex');
  const web = join(rootDir, 'apps/web/dist/index.html');
  for (const path of [dmg, runtime, web]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(dmg, 'signed-dmg');
  writeFileSync(zip, 'signed-zip');
  writeFileSync(metadata, `version: 1.0.12\nfiles:\n  - url: ${basename(zip)}\n    sha512: stale\n`);
  writeFileSync(runtime, 'runtime');
  chmodSync(runtime, 0o755);
  writeFileSync(web, 'web');
  const artifactPaths = [dmg, zip, metadata];
  const manifest = {
    version: 2, mode: 'release', dirty: false, commit: expected.sha,
    releaseVersion: '1.0.12', arch: expected.arch, platform: 'darwin',
    artifacts: await describeReleaseArtifacts(artifactPaths, rootDir)
  };
  const recovery = await createNotaryRecovery({ directory, rootDir, manifest, teamId: expected.teamId });
  return { rootDir, directory, recovery, dmg, zip, metadata, runtime };
}

describe('公证恢复检查点', () => {
  it('留存原始文件和校验上下文，不把凭据写入检查点', async () => {
    vi.stubEnv('APPLE_APP_SPECIFIC_PASSWORD', 'sensitive-password');
    const input = await fixture();
    const checkpoint = await loadNotaryRecovery(input.directory, expected);
    expect(checkpoint.stage).toBe('built');
    expect(readFileSync(join(input.directory, checkpoint.files[0].name), 'utf8')).toBe('signed-dmg');
    expect(readFileSync(join(input.directory, checkpointFilename), 'utf8')).not.toContain('sensitive-password');
  });

  it.each([
    ['仓库', value => { value.source.repository = 'other/repo'; }],
    ['任务', value => { value.source.runId = '9999'; }],
    ['执行次数', value => { value.source.runAttempt = '2'; }],
    ['标签', value => { value.tag = 'v1.0.13'; }],
    ['源码', value => { value.manifest.commit = 'b'.repeat(40); }],
    ['Team', value => { value.teamId = 'OTHER'; }],
    ['架构', value => { value.manifest.arch = 'invalid'; }],
    ['脏源码', value => { value.manifest.dirty = true; }],
    ['未签名模式', value => { value.manifest.mode = 'dist'; }],
    ['未知阶段', value => { value.stage = 'unknown'; }],
    ['缺失文件', value => { value.files.pop(); }],
    ['重复文件', value => { value.files.push(value.files[0]); }],
    ['跨目录路径', value => { value.files[0].name = '../escape.dmg'; }],
    ['清单哈希', value => { value.manifest.artifacts[0].sha256 = 'b'.repeat(64); }],
    ['不明确上传', value => { value.submission.state = 'submitting'; value.stage = 'submit'; }]
  ])('拒绝不匹配的%s', async (_, mutate) => {
    const input = await fixture();
    const checkpoint = JSON.parse(readFileSync(join(input.directory, checkpointFilename), 'utf8'));
    mutate(checkpoint);
    writeFileSync(join(input.directory, checkpointFilename), JSON.stringify(checkpoint));
    await expect(loadNotaryRecovery(input.directory, expected)).rejects.toThrow();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('拒绝大小相同但内容被篡改的安装包', async () => {
    const input = await fixture();
    writeFileSync(join(input.directory, input.recovery.checkpoint.files[0].name), 'altered!!!');
    await expect(loadNotaryRecovery(input.directory, expected)).rejects.toThrow('哈希不匹配');
  });

  it('装订改变 DMG 后同步保存新文件和哈希', async () => {
    const input = await fixture();
    writeFileSync(input.dmg, 'stapled-dmg');
    await saveNotaryRecovery(input.recovery, {
      stage: 'staple', submission: { state: 'submitted', id: submissionId }
    });
    const checkpoint = await loadNotaryRecovery(input.directory, expected);
    expect(checkpoint.submission.id).toBe(submissionId);
    expect(readFileSync(join(input.directory, checkpoint.files[0].name), 'utf8')).toBe('stapled-dmg');
  });

  it('还原原始验证上下文并保留 Runtime 可执行权限', async () => {
    const input = await fixture();
    rmSync(input.runtime);
    writeFileSync(join(input.rootDir, 'apps/web/dist/stale.html'), 'stale');
    await restoreVerificationContext(input.directory, input.rootDir);
    expect(readFileSync(input.runtime, 'utf8')).toBe('runtime');
    if (process.platform !== 'win32') expect(lstatSync(input.runtime).mode & 0o111).toBe(0o111);
    expect(existsSync(join(input.rootDir, 'apps/web/dist/stale.html'))).toBe(false);
  });

  it('归档包含非验证文件时，在解包或删除原上下文之前拒绝', async () => {
    const input = await fixture();
    writeFileSync(join(input.rootDir, 'unrelated.txt'), 'unrelated');
    await tar.c({ file: join(input.directory, 'verification-context.tar.gz'), cwd: input.rootDir, gzip: true }, ['unrelated.txt']);
    await expect(restoreVerificationContext(input.directory, input.rootDir)).rejects.toThrow('非验证文件或链接');
    expect(readFileSync(input.runtime, 'utf8')).toBe('runtime');
  });

  it.runIf(process.platform !== 'win32')('拒绝验证上下文中的符号链接', async () => {
    const input = await fixture();
    symlinkSync(input.runtime, join(input.rootDir, 'apps/web/dist/link'));
    await tar.c({ file: join(input.directory, 'verification-context.tar.gz'), cwd: input.rootDir, gzip: true }, ['apps/web/dist']);
    await expect(restoreVerificationContext(input.directory, input.rootDir)).rejects.toThrow('非验证文件或链接');
    expect(readFileSync(input.runtime, 'utf8')).toBe('runtime');
  });

  it('诊断只保留脱敏错误，不保存环境变量', () => {
    expect(notaryFailureDiagnostic(new Error('password=secret token=token-value'), {
      APPLE_APP_SPECIFIC_PASSWORD: 'secret', GH_TOKEN: 'token-value', UNRELATED: 'value'
    })).toEqual({ message: 'password=*** token=***' });
    expect(notaryFailureDiagnostic(new Error('password=secret'), {
      APPLE_APP_SPECIFIC_PASSWORD: ' secret '
    })).toEqual({ message: 'password=***' });
  });
});

describe('公证收尾', () => {
  it('查询失败前已保存提交 ID，恢复只查询同一提交', async () => {
    const input = await fixture();
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      if (args[0] === 'notarytool' && args[1] === 'submit') return { ...success, stdout: JSON.stringify({ id: submissionId }) };
      if (args[0] === 'notarytool') return { status: 1, stderr: 'query failed' };
      return success;
    });
    await expect(finalizeReleaseDmgArtifacts([input.dmg], [], input.recovery)).rejects.toThrow('query failed');
    const checkpoint = await loadNotaryRecovery(input.directory, expected);
    expect(checkpoint.submission).toEqual({ state: 'submitted', id: submissionId });
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockImplementation((command, args) => args[0] === 'notarytool'
      ? { ...success, stdout: JSON.stringify({ id: submissionId, status: 'Accepted' }) } : success);
    await finalizeReleaseDmgArtifacts([input.dmg], [], input.recovery);
    const notaryCalls = vi.mocked(spawnSync).mock.calls.filter(([, args]) => args[0] === 'notarytool');
    expect(notaryCalls).toHaveLength(1);
    expect(notaryCalls[0][1]).toEqual(['notarytool', 'info', submissionId, '--output-format', 'json']);
    expect(input.recovery.checkpoint.stage).toBe('gatekeeper');
  });

  it('拒绝的公证不装订、不重新提交', async () => {
    const input = await fixture();
    await saveNotaryRecovery(input.recovery, { stage: 'submit', submission: { state: 'submitted', id: submissionId } });
    vi.mocked(spawnSync).mockImplementation((command, args) => args[0] === 'notarytool'
      ? { ...success, stdout: JSON.stringify({ id: submissionId, status: 'Invalid' }) } : success);
    await expect(finalizeReleaseDmgArtifacts([input.dmg], [], input.recovery)).rejects.toThrow('公证未通过');
    expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args.includes('staple') || args.includes('submit'))).toBe(false);
  });
});

describe('完整公证恢复命令', () => {
  it.runIf(process.platform === 'darwin')('不调用 builder，重算更新哈希，重新验证后才产生完成清单', async () => {
    const input = await fixture();
    await saveNotaryRecovery(input.recovery, { stage: 'staple', submission: { state: 'submitted', id: submissionId } });
    vi.stubEnv('APPLE_ID', 'release@example.com');
    vi.stubEnv('APPLE_APP_SPECIFIC_PASSWORD', 'secret');
    vi.stubEnv('APPLE_TEAM_ID', expected.teamId);
    vi.stubEnv('GITHUB_ENV', '');
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      if (command === 'git') return { ...success, stdout: expected.sha };
      if (args[0] === 'notarytool') return { ...success, stdout: JSON.stringify({ id: submissionId, status: 'Accepted' }) };
      return success;
    });
    const manifestPath = join(input.rootDir, 'apps/desktop/release/completed.json');
    await resumeMacNotary({ directory: input.directory, rootDir: input.rootDir, manifestPath, expected });
    expect(readFileSync(input.metadata, 'utf8')).not.toContain('stale');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.recoveredFrom.runId).toBe(expected.runId);
    expect(manifest.commit).toBe(expected.sha);
    expect(runStage).toHaveBeenCalledExactlyOnceWith('验证恢复后的桌面包', process.execPath,
      [join(input.rootDir, 'apps/desktop/scripts/verify-package.mjs')], expect.objectContaining({
        env: expect.objectContaining({ CLAWEE_REQUIRE_DISTRIBUTABLE_MAC: '1' })
      }));
    expect(vi.mocked(spawnSync).mock.calls.some(([command, args]) => command === 'electron-builder' || args.includes('submit'))).toBe(false);
    expect((await loadNotaryRecovery(input.directory, expected)).stage).toBe('verified');
  });

  it.runIf(process.platform === 'darwin')('最终验证失败时删除完成清单并留下可再次恢复的错误', async () => {
    const input = await fixture();
    await saveNotaryRecovery(input.recovery, { stage: 'staple', submission: { state: 'submitted', id: submissionId } });
    vi.stubEnv('APPLE_ID', 'release@example.com');
    vi.stubEnv('APPLE_APP_SPECIFIC_PASSWORD', 'secret');
    vi.stubEnv('APPLE_TEAM_ID', expected.teamId);
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      if (command === 'git') return { ...success, stdout: expected.sha };
      if (args[0] === 'notarytool') return { ...success, stdout: JSON.stringify({ id: submissionId, status: 'Accepted' }) };
      return success;
    });
    vi.mocked(runStage).mockRejectedValue(new Error('package verification failed'));
    const manifestPath = join(input.rootDir, 'apps/desktop/release/completed.json');
    await expect(resumeMacNotary({ directory: input.directory, rootDir: input.rootDir, manifestPath, expected }))
      .rejects.toThrow('package verification failed');
    expect(existsSync(manifestPath)).toBe(false);
    const checkpoint = await loadNotaryRecovery(input.directory, expected);
    expect(checkpoint.stage).toBe('package');
    expect(checkpoint.failure.message).toBe('package verification failed');
  });
});
