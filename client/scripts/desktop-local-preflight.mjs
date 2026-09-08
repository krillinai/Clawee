import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStage } from '../apps/desktop/scripts/script-utils.mjs';

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
const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log([
    'Usage: node scripts/desktop-local-preflight.mjs [--release]',
    '',
    'Default mode validates a dirty development worktree before commit.',
    '--release requires a clean worktree and also validates macOS release credentials.'
  ].join('\n'));
  process.exit(0);
}
const unknownArgs = args.filter(arg => arg !== '--release');
if (unknownArgs.length > 0) {
  throw new Error(`Unsupported local preflight arguments: ${unknownArgs.join(' ')}`);
}

const releaseReady = args.includes('--release');
const startedCommit = gitOutput(['rev-parse', 'HEAD']);
const startedStatus = gitOutput([
  'status',
  '--porcelain',
  '--untracked-files=all'
]);
if (releaseReady && startedStatus.length > 0) {
  throw new Error(
    'Desktop release preflight requires a clean Git worktree. '
    + 'Commit the locally validated changes before running it.'
  );
}

const stages = [
  ...(releaseReady
    ? [{
        label: '验证 macOS 正式签名与公证凭据',
        command: 'pnpm',
        args: ['desktop:release:doctor'],
        timeoutMs: 2 * 60_000
      }]
    : []),
  {
    label: '验证 Codex Runtime 发布契约',
    command: 'pnpm',
    args: ['codex:runtime:verify'],
    timeoutMs: 5 * 60_000
  },
  {
    label: '运行仓库测试',
    command: 'pnpm',
    args: ['test'],
    timeoutMs: 45 * 60_000
  },
  {
    label: '运行仓库类型检查',
    command: 'pnpm',
    args: ['typecheck'],
    timeoutMs: 30 * 60_000
  },
  {
    label: '生成本机 Desktop App',
    command: 'pnpm',
    args: ['desktop:package'],
    timeoutMs: 45 * 60_000
  },
  {
    label: '验证实际打包 App',
    command: 'pnpm',
    args: ['--filter', '@clawee/desktop', 'e2e:embedded-runtime'],
    timeoutMs: 20 * 60_000
  }
];

for (const stage of stages) {
  await runStage(stage.label, stage.command, stage.args, {
    cwd: rootDir,
    timeoutMs: stage.timeoutMs
  });
}

const finishedCommit = gitOutput(['rev-parse', 'HEAD']);
if (finishedCommit !== startedCommit) {
  throw new Error('Git HEAD changed while Desktop local preflight was running');
}
const finishedStatus = gitOutput([
  'status',
  '--porcelain',
  '--untracked-files=all'
]);
if (releaseReady && finishedStatus.length > 0) {
  throw new Error(
    'Desktop release preflight changed or detected tracked files; '
    + 'the target release worktree is no longer clean.'
  );
}
if (!existsSync(buildManifestPath)) {
  throw new Error('Desktop package did not produce its build manifest');
}

const buildManifest = JSON.parse(readFileSync(buildManifestPath, 'utf8'));
const expectedDirty = finishedStatus.length > 0;
if (
  buildManifest.commit !== finishedCommit
  || buildManifest.dirty !== expectedDirty
  || buildManifest.mode !== 'dir'
) {
  throw new Error(
    'Desktop build manifest does not describe the locally validated worktree'
  );
}
if (
  typeof buildManifest.packageRoot !== 'string'
  || !existsSync(buildManifest.packageRoot)
) {
  throw new Error('Desktop build manifest package root is missing');
}

const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'));
const receipt = {
  schemaVersion: 1,
  commit: finishedCommit,
  dirty: expectedDirty,
  worktreeStatusSha256: hashText(finishedStatus),
  releaseReady,
  expectedTag: `v${desktopPackage.version}`,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  checks: stages.map(stage => stage.label),
  buildManifest: {
    path: relative(rootDir, buildManifestPath),
    generatedAt: buildManifest.generatedAt,
    packageRoot: buildManifest.packageRoot,
    webBuildHash: buildManifest.webBuildHash,
    webFileCount: buildManifest.webFileCount,
    codexRuntimeVersion: buildManifest.codexRuntimeVersion,
    codexRuntimeContentSha256: buildManifest.codexRuntimeContentSha256
  }
};
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

console.log(
  `[desktop-preflight] 本地预检通过：commit=${finishedCommit} `
  + `dirty=${expectedDirty} releaseReady=${releaseReady}`
);
console.log(`[desktop-preflight] 证据：${receiptPath}`);

function gitOutput(args) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 30_000
  });
  if (result.status !== 0) {
    if (!releaseReady && args.join(' ') === 'rev-parse HEAD'
      && gitOutput(['rev-parse', '--is-inside-work-tree']) === 'true') {
      return 'unknown';
    }
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}
