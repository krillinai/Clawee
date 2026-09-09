import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const desktopPackagePath = resolve(rootDir, 'apps/desktop/package.json');
const buildManifestPath = resolve(
  rootDir,
  'apps/desktop/release/clawee-desktop-build-manifest.json'
);
const receiptPath = resolve(
  rootDir,
  'apps/desktop/release/clawee-desktop-local-preflight.json'
);
const args = process.argv.slice(2).filter(arg => arg !== '--');

if (args.includes('--help')) {
  console.log([
    'Usage: pnpm desktop:tag:check -- [v<version>]',
    '',
    'Checks local release evidence, pushed HEAD, GitHub Release Preflight status,',
    'tag immutability, and macOS signing credentials. It never creates a tag.'
  ].join('\n'));
  process.exit(0);
}
if (args.length > 1) {
  throw new Error('Desktop tag check accepts at most one version tag');
}

const desktopPackage = readJson(desktopPackagePath, 'Desktop package');
const expectedTag = `v${desktopPackage.version}`;
const requestedTag = args[0] ?? expectedTag;
if (requestedTag !== expectedTag) {
  throw new Error(
    `Desktop tag ${requestedTag} does not match package version `
    + `${desktopPackage.version}; expected ${expectedTag}`
  );
}

const status = gitOutput(['status', '--porcelain', '--untracked-files=all']);
if (status.length > 0) {
  throw new Error(
    'Desktop tag check requires a clean Git worktree. '
    + 'Do not create a release tag from uncommitted code.'
  );
}
const head = gitOutput(['rev-parse', 'HEAD']);
const upstream = gitOutput(['rev-parse', '@{upstream}']);
if (head !== upstream) {
  throw new Error(
    `Local HEAD ${head} is not the pushed upstream commit ${upstream}`
  );
}

const receipt = readJson(receiptPath, 'Desktop local preflight receipt');
const buildManifest = readJson(buildManifestPath, 'Desktop build manifest');
if (
  receipt.schemaVersion !== 1
  || receipt.commit !== head
  || receipt.dirty !== false
  || receipt.releaseReady !== true
  || receipt.expectedTag !== expectedTag
) {
  throw new Error(
    'Desktop local release preflight evidence does not match the target commit. '
    + 'Run pnpm desktop:preflight:release again.'
  );
}
const maxAgeHours = positiveNumber(
  process.env.CLAWEE_LOCAL_PREFLIGHT_MAX_AGE_HOURS,
  24
);
const ageMs = Date.now() - Date.parse(receipt.generatedAt);
if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeHours * 60 * 60_000) {
  throw new Error(
    `Desktop local release preflight is older than ${maxAgeHours} hours`
  );
}
if (
  buildManifest.commit !== head
  || buildManifest.dirty !== false
  || buildManifest.mode !== 'dir'
  || receipt.buildManifest?.generatedAt !== buildManifest.generatedAt
  || receipt.buildManifest?.webBuildHash !== buildManifest.webBuildHash
  || receipt.buildManifest?.codexRuntimeContentSha256
    !== buildManifest.codexRuntimeContentSha256
) {
  throw new Error(
    'Desktop package manifest no longer matches the local release preflight evidence'
  );
}
if (
  typeof buildManifest.packageRoot !== 'string'
  || !existsSync(buildManifest.packageRoot)
) {
  throw new Error('The locally validated Desktop package no longer exists');
}

assertTagDoesNotExist(requestedTag);
const preflightState = commandOutput('gh', [
  'api',
  `repos/{owner}/{repo}/commits/${head}/status`,
  '--jq',
  '[.statuses[] | select(.context == "release-preflight")][0].state // "missing"'
]);
if (preflightState !== 'success') {
  throw new Error(
    `Commit ${head} Release Preflight status is ${preflightState}; `
    + 'do not create or push the release tag.'
  );
}
commandOutput('pnpm', ['desktop:release:doctor'], { inherit: true });

console.log(
  `[desktop-tag-check] ${requestedTag} 可以创建：commit=${head} `
  + 'local=passed remote=passed credentials=passed'
);
console.log('[desktop-tag-check] 本命令没有创建或推送任何 Tag。');

function assertTagDoesNotExist(tag) {
  const local = spawnSync('git', [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/tags/${tag}`
  ], {
    cwd: rootDir,
    timeout: 30_000
  });
  if (local.status === 0) {
    throw new Error(`Local tag ${tag} already exists; release tags are immutable`);
  }
  if (local.status !== 1) {
    throw new Error(`Unable to inspect local tag ${tag}`);
  }

  const remote = spawnSync('git', [
    'ls-remote',
    '--exit-code',
    '--tags',
    'origin',
    `refs/tags/${tag}`
  ], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 30_000
  });
  if (remote.status === 0) {
    throw new Error(`Remote tag ${tag} already exists; release tags are immutable`);
  }
  if (remote.status !== 2) {
    throw new Error(
      `Unable to inspect remote tag ${tag}: ${remote.stderr || remote.stdout}`
    );
  }
}

function readJson(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function gitOutput(args) {
  return commandOutput('git', args);
}

function commandOutput(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : undefined,
    timeout: 2 * 60_000
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed: `
      + `${result.stderr || result.stdout || `exit ${result.status}`}`
    );
  }
  return options.inherit ? '' : result.stdout.trim();
}

function positiveNumber(value, fallback) {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('CLAWEE_LOCAL_PREFLIGHT_MAX_AGE_HOURS must be positive');
  }
  return parsed;
}
