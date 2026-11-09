import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const reusableReleaseJobs = [
  'target',
  'preflight / client',
  'preflight / server',
  'preflight / container',
  'preflight / server-package (amd64)',
  'preflight / server-package (arm64)',
  'preflight / desktop (macos-arm64, macos-14, mac, arm64)',
  'preflight / desktop (macos-x64, macos-15-intel, mac, x64)',
  'preflight / desktop (windows-x64-unsigned, windows-latest, win, x64)',
  'preflight / cos-preflight-upload',
  'preflight / record',
  'gate',
  'desktop (macos-arm64, macos-14, mac, arm64)',
  'desktop (macos-x64, macos-15-intel, mac, x64)',
  'desktop (windows-x64-unsigned, windows-latest, win, x64)',
  'server / packages (amd64)',
  'server / packages (arm64)'
];

export const reusableReleaseArtifacts = [
  'clawee-desktop-release-macos-arm64',
  'clawee-desktop-release-macos-x64',
  'clawee-desktop-release-windows-x64-unsigned',
  'clawee-server-release-linux-amd64',
  'clawee-server-release-linux-arm64'
];

export function verifyReleaseReuse(input) {
  const { run, jobs, artifacts, commitStatus, repository, sha } = input;
  assert.equal(run.repository.full_name, repository, 'Release repository mismatch');
  assert.equal(run.head_repository.full_name, repository, 'Fork artifacts are not trusted');
  assert.equal(run.path, '.github/workflows/release.yml', 'Not a Release workflow');
  assert(['push', 'workflow_dispatch'].includes(run.event), 'Untrusted Release event');
  assert.equal(run.status, 'completed', 'Release artifacts are still being generated');
  assert.equal(commitStatus.sha, sha, 'Preflight commit mismatch');
  const preflight = commitStatus.statuses.find(status => status.context === 'release-preflight');
  assert.equal(preflight?.state, 'success', 'Release Preflight has not passed');
  assert.equal(preflight?.target_url, run.html_url, 'Preflight belongs to another run');
  const candidateResults = new Set();
  for (const name of reusableReleaseJobs) {
    if (input.desktopOnly && name.startsWith('server / packages')) continue;
    const candidate = /^preflight \/ (desktop|server-package|container|cos-preflight-upload)(?: |$)/.test(name);
    const baseName = name.replace(/ \(.*\)$/, '');
    const matches = jobs.filter(job => job.name === name || (candidate && job.name === baseName));
    assert.equal(matches.length, 1, `Missing or duplicate Release job: ${name}`);
    if (input.desktopOnly && name === 'preflight / server') {
      assert(['success', 'skipped'].includes(matches[0].conclusion), 'Server preflight must pass or be skipped');
    } else if (candidate) {
      assert(['success', 'skipped'].includes(matches[0].conclusion), `Candidate preflight job has not passed: ${name}`);
      candidateResults.add(matches[0].conclusion);
    } else {
      assert.equal(matches[0].conclusion, 'success', `Release job has not passed: ${name}`);
    }
  }
  assert.equal(candidateResults.size, 1, 'Candidate preflight jobs must all pass or all be skipped');
  for (const name of reusableReleaseArtifacts) {
    if (input.desktopOnly && name.startsWith('clawee-server-release-')) continue;
    const matches = artifacts.filter(artifact => artifact.name === name);
    assert.equal(matches.length, 1, `Missing or duplicate Release artifact: ${name}`);
    assert.equal(matches[0].expired, false, `Release artifact expired: ${name}`);
  }
}

export function verifyReleaseArtifactIdentity({ directory, tag, sha, desktopOnly = false }) {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.match(sha, /^[0-9a-f]{40}$/);
  const version = tag.slice(1);
  for (const target of ['mac-arm64', 'mac-x64', 'win-x64']) {
    verifyDesktopArtifactIdentity({ directory, tag, sha, target, allArtifacts: false });
  }
  for (const name of [
    `Clawee-${version}-arm64.dmg`, `Clawee-${version}.dmg`,
    `Clawee-${version}-arm64-mac.zip`, `Clawee-${version}-mac.zip`,
    `Clawee-Setup-${version}.exe`
  ]) assert(existsSync(join(directory, name)), `Missing release installer: ${name}`);
  if (desktopOnly) return;
  for (const arch of ['amd64', 'arm64']) {
    const name = `clawee-server-${tag}-linux-${arch}.tar.gz`;
    const hash = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
    const checksum = readFileSync(join(directory, `server-linux-${arch}-SHA256SUMS`), 'utf8').trim();
    assert.equal(checksum, `${hash}  ${name}`, `Server checksum mismatch: ${arch}`);
  }
}

export function verifyDesktopArtifactIdentity({ directory, tag, sha, target, allArtifacts = true }) {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert(['mac-arm64', 'mac-x64', 'win-x64'].includes(target), 'Unknown Desktop target');
  const version = tag.slice(1);
  const mode = target === 'win-x64' ? 'dist' : 'release';
  const manifest = JSON.parse(readFileSync(join(directory, `clawee-desktop-build-manifest-${target}.json`), 'utf8'));
  assert.equal(manifest.commit, sha, `Desktop source mismatch: ${target}`);
  assert.equal(manifest.releaseVersion, version, `Desktop version mismatch: ${target}`);
  assert.equal(typeof manifest.dirty, 'boolean', `Missing Desktop source status: ${target}`);
  if (mode === 'release') assert.equal(manifest.dirty, false, `Signed Desktop source is dirty: ${target}`);
  assert.equal(manifest.mode, mode, `Desktop packaging mode mismatch: ${target}`);
  const installers = target === 'win-x64' ? [`Clawee-Setup-${version}.exe`]
    : target === 'mac-arm64' ? [`Clawee-${version}-arm64.dmg`, `Clawee-${version}-arm64-mac.zip`]
      : [`Clawee-${version}.dmg`, `Clawee-${version}-mac.zip`];
  for (const name of installers) {
    assert(manifest.artifacts?.some(item => basename(item.relativePath.replaceAll('\\', '/')) === name),
      `Installer missing from Desktop build manifest: ${name}`);
  }
  const names = new Set();
  const artifacts = allArtifacts ? manifest.artifacts : manifest.artifacts.filter(artifact =>
    installers.includes(basename(artifact.relativePath.replaceAll('\\', '/'))));
  for (const artifact of artifacts) {
    const name = basename(artifact.relativePath.replaceAll('\\', '/'));
    assert(name !== '.' && name !== '..' && !names.has(name), 'Invalid or duplicate Desktop artifact name');
    names.add(name);
    const path = join(directory, name);
    assert(lstatSync(path).isFile(), 'Desktop artifacts must be regular files');
    assert.equal(statSync(path).size, artifact.bytes, `Desktop installer size mismatch: ${name}`);
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(hash, artifact.sha256, `Desktop installer checksum mismatch: ${name}`);
  }
}

function runCli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'run-id': { type: 'string' }, repository: { type: 'string' },
      sha: { type: 'string' }, tag: { type: 'string' }, directory: { type: 'string' },
      'desktop-only': { type: 'boolean', default: false }, target: { type: 'string' }
    }
  });
  if (positionals[0] === 'artifacts') {
    if (values.target) {
      verifyDesktopArtifactIdentity({ directory: values.directory, tag: values.tag, sha: values.sha, target: values.target });
    } else {
      verifyReleaseArtifactIdentity({
        directory: values.directory, tag: values.tag, sha: values.sha,
        desktopOnly: values['desktop-only']
      });
    }
  } else {
    assert.equal(positionals[0], 'run');
    assert.match(values['run-id'] ?? '', /^\d+$/);
    assert.match(values.sha ?? '', /^[0-9a-f]{40}$/);
    assert.match(values.repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    const load = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024
    }));
    const runPath = `repos/${values.repository}/actions/runs/${values['run-id']}`;
    verifyReleaseReuse({
      run: load(runPath), jobs: load(`${runPath}/jobs?per_page=100`).jobs,
      artifacts: load(`${runPath}/artifacts?per_page=100`).artifacts,
      commitStatus: load(`repos/${values.repository}/commits/${values.sha}/status`),
      repository: values.repository, sha: values.sha, desktopOnly: values['desktop-only']
    });
  }
  console.log(JSON.stringify({ verified: true, runId: values['run-id'], sha: values.sha }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli();
