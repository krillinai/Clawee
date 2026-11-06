import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  reusableReleaseArtifacts, reusableReleaseJobs,
  verifyDesktopArtifactIdentity, verifyReleaseArtifactIdentity, verifyReleaseReuse
} from './verify-release-reuse.mjs';

const sha = '5ab2935b63e6ee10c0b53f1ff0e681c4dec2e4ec';
const repository = 'krillinai/ClaweePro';
const runUrl = `https://github.com/${repository}/actions/runs/38147021010`;

function evidence() {
  return {
    repository, sha,
    run: {
      repository: { full_name: repository }, head_repository: { full_name: repository },
      path: '.github/workflows/release.yml', event: 'workflow_dispatch',
      status: 'completed', html_url: runUrl
    },
    jobs: reusableReleaseJobs.map(name => ({ name, conclusion: 'success' })),
    artifacts: reusableReleaseArtifacts.map(name => ({ name, expired: false })),
    commitStatus: { sha, statuses: [{ context: 'release-preflight', state: 'success', target_url: runUrl }] }
  };
}

test('accepts signed artifacts after all package and preflight jobs pass', () => {
  verifyReleaseReuse(evidence());
});

test('accepts source-only preflight with candidate jobs skipped and release packages verified', () => {
  const input = evidence();
  for (const job of input.jobs) {
    if (/^preflight \/ (desktop|server-package|container|cos-preflight-upload)/.test(job.name)) {
      job.conclusion = 'skipped';
    }
  }
  verifyReleaseReuse(input);
});

test('rejects partially skipped candidate preflight jobs', () => {
  const input = evidence();
  input.jobs.find(job => job.name === 'preflight / container').conclusion = 'skipped';
  assert.throws(() => verifyReleaseReuse(input));
});

test('accepts skipped candidate matrix jobs without expanded job names', () => {
  const input = evidence();
  input.jobs = input.jobs.filter(job => !/^preflight \/ (desktop|server-package)/.test(job.name));
  input.jobs.push(
    { name: 'preflight / desktop', conclusion: 'skipped' },
    { name: 'preflight / server-package', conclusion: 'skipped' }
  );
  for (const job of input.jobs) {
    if (['preflight / container', 'preflight / cos-preflight-upload'].includes(job.name)) job.conclusion = 'skipped';
  }
  verifyReleaseReuse(input);
});

test('仅客户端复用允许关闭服务端预检和打包，但不放宽客户端验证', () => {
  const input = { ...evidence(), desktopOnly: true };
  input.jobs = input.jobs.filter(job => !job.name.startsWith('server / packages'));
  for (const job of input.jobs) {
    if (/^preflight \/ (server|desktop|server-package|container|cos-preflight-upload)(?: |$)/.test(job.name)) {
      job.conclusion = 'skipped';
    }
  }
  input.artifacts = input.artifacts.filter(item => item.name.startsWith('clawee-desktop-release-'));
  verifyReleaseReuse(input);
  assert.throws(() => verifyReleaseReuse({ ...input, desktopOnly: false }));
  for (const name of ['preflight / client', 'gate', 'desktop (macos-arm64, macos-14, mac, arm64)']) {
    const job = input.jobs.find(item => item.name === name);
    for (const conclusion of ['failure', 'cancelled', 'skipped']) {
      job.conclusion = conclusion;
      assert.throws(() => verifyReleaseReuse(input));
    }
    job.conclusion = 'success';
  }
  input.artifacts[0].expired = true;
  assert.throws(() => verifyReleaseReuse(input));
  input.artifacts[0].expired = false;
  input.artifacts.pop();
  assert.throws(() => verifyReleaseReuse(input));
});

for (const [name, mutate] of [
  ['fork', input => { input.run.head_repository.full_name = 'other/repo'; }],
  ['wrong workflow', input => { input.run.path = '.github/workflows/ci.yml'; }],
  ['PR', input => { input.run.event = 'pull_request'; }],
  ['running job', input => { input.run.status = 'in_progress'; }],
  ['wrong SHA', input => { input.commitStatus.sha = '0'.repeat(40); }],
  ['failed preflight', input => { input.commitStatus.statuses[0].state = 'failure'; }],
  ['failed source check', input => { input.jobs.find(job => job.name === 'preflight / client').conclusion = 'failure'; }],
  ['cancelled source check', input => { input.jobs.find(job => job.name === 'preflight / server').conclusion = 'cancelled'; }],
  ['failed candidate check', input => { input.jobs.find(job => job.name === 'preflight / container').conclusion = 'failure'; }],
  ['other preflight run', input => { input.commitStatus.statuses[0].target_url += '1'; }],
  ['failed package', input => { input.jobs.at(-1).conclusion = 'failure'; }],
  ['missing package', input => { input.jobs.pop(); }],
  ['missing artifact', input => { input.artifacts.pop(); }],
  ['expired artifact', input => { input.artifacts[0].expired = true; }]
]) {
  test(`rejects ${name} evidence`, () => {
    const input = evidence();
    mutate(input);
    assert.throws(() => verifyReleaseReuse(input));
  });
}

test('pins downloaded installers and build manifests to the tag source and signed mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-release-reuse-'));
  const installerHash = createHash('sha256').update('test').digest('hex');
  const installerNames = {
    'mac-arm64': ['Clawee-1.0.5-arm64.dmg', 'Clawee-1.0.5-arm64-mac.zip'],
    'mac-x64': ['Clawee-1.0.5.dmg', 'Clawee-1.0.5-mac.zip'],
    'win-x64': ['Clawee-Setup-1.0.5.exe']
  };
  const buildManifest = (target, mode) => ({
    commit: sha, releaseVersion: '1.0.5', dirty: target === 'win-x64', mode,
    artifacts: installerNames[target].map(name => ({
      relativePath: `apps\\desktop\\release\\${name}`, bytes: 4, sha256: installerHash
    }))
  });
  try {
    for (const [target, mode] of [['mac-arm64', 'release'], ['mac-x64', 'release'], ['win-x64', 'dist']]) {
      writeFileSync(join(directory, `clawee-desktop-build-manifest-${target}.json`), JSON.stringify(buildManifest(target, mode)));
    }
    for (const name of [
      'Clawee-1.0.5-arm64.dmg', 'Clawee-1.0.5.dmg', 'Clawee-1.0.5-arm64-mac.zip',
      'Clawee-1.0.5-mac.zip', 'Clawee-Setup-1.0.5.exe'
    ]) writeFileSync(join(directory, name), 'test');
    const input = { directory, tag: 'v1.0.5', sha };
    for (const target of ['mac-arm64', 'mac-x64']) {
      const path = join(directory, `clawee-desktop-build-manifest-${target}.json`);
      const manifest = buildManifest(target, 'release');
      manifest.artifacts.push({
        relativePath: 'apps/desktop/release/latest-mac.yml', bytes: target.length,
        sha256: createHash('sha256').update(target).digest('hex')
      });
      writeFileSync(path, JSON.stringify(manifest));
    }
    writeFileSync(join(directory, 'latest-mac.yml'), 'mac-x64');
    verifyReleaseArtifactIdentity({ ...input, desktopOnly: true });
    assert.throws(() => verifyReleaseArtifactIdentity(input), /ENOENT/);
    for (const arch of ['amd64', 'arm64']) {
      const name = `clawee-server-v1.0.5-linux-${arch}.tar.gz`;
      writeFileSync(join(directory, name), 'test');
      const hash = createHash('sha256').update('test').digest('hex');
      writeFileSync(join(directory, `server-linux-${arch}-SHA256SUMS`), `${hash}  ${name}\n`);
    }
    verifyReleaseArtifactIdentity(input);
    const manifestPath = join(directory, 'clawee-desktop-build-manifest-mac-arm64.json');
    const manifest = buildManifest('mac-arm64', 'release');
    for (const invalid of [{ dirty: true }, { mode: 'dist' }, { commit: '0'.repeat(40) }]) {
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, ...invalid }));
      assert.throws(() => verifyReleaseArtifactIdentity(input));
      assert.throws(() => verifyReleaseArtifactIdentity({ ...input, desktopOnly: true }));
    }
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const installerPath = join(directory, 'Clawee-Setup-1.0.5.exe');
    writeFileSync(installerPath, 'fail');
    assert.throws(() => verifyReleaseArtifactIdentity(input), /checksum mismatch/);
    assert.throws(() => verifyReleaseArtifactIdentity({ ...input, desktopOnly: true }), /checksum mismatch/);
    writeFileSync(installerPath, 'changed size');
    assert.throws(() => verifyReleaseArtifactIdentity(input), /size mismatch/);
    writeFileSync(installerPath, 'test');
    const windowsManifestPath = join(directory, 'clawee-desktop-build-manifest-win-x64.json');
    const windowsManifest = buildManifest('win-x64', 'dist');
    for (const invalid of [{ dirty: undefined }, { mode: 'release' }, { artifacts: [] }]) {
      writeFileSync(windowsManifestPath, JSON.stringify({ ...windowsManifest, ...invalid }));
      assert.throws(() => verifyReleaseArtifactIdentity(input));
    }
    writeFileSync(windowsManifestPath, JSON.stringify(windowsManifest));
    assert.throws(() => verifyReleaseArtifactIdentity({ ...input, sha: '0'.repeat(40) }));
    assert.throws(() => verifyReleaseArtifactIdentity({ ...input, tag: 'v1.0.6' }));
    writeFileSync(join(directory, 'server-linux-amd64-SHA256SUMS'), 'invalid');
    assert.throws(() => verifyReleaseArtifactIdentity(input));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('独立验证复用 Windows 包，同时校验更新元数据哈希', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-notary-windows-reuse-'));
  try {
    const names = ['Clawee-Setup-1.0.12.exe', 'latest.yml'];
    for (const name of names) writeFileSync(join(directory, name), 'test');
    writeFileSync(join(directory, 'clawee-desktop-build-manifest-win-x64.json'), JSON.stringify({
      commit: sha, releaseVersion: '1.0.12', dirty: false, mode: 'dist',
      artifacts: names.map(name => ({
        relativePath: `apps/desktop/release/${name}`, bytes: 4,
        sha256: createHash('sha256').update('test').digest('hex')
      }))
    }));
    const input = { directory, tag: 'v1.0.12', sha, target: 'win-x64' };
    verifyDesktopArtifactIdentity(input);
    assert.throws(() => verifyDesktopArtifactIdentity({ ...input, target: 'unknown' }));
    writeFileSync(join(directory, 'latest.yml'), 'fail');
    assert.throws(() => verifyDesktopArtifactIdentity(input), /checksum mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
