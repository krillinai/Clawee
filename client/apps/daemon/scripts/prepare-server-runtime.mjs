import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const manifest = JSON.parse(readFileSync(
  resolve(repositoryRoot, 'config/codex-runtime.json'),
  'utf8'
));
const target = Object.values(manifest.targets).find(candidate =>
  candidate.platform === process.platform && candidate.arch === process.arch
);
if (target === undefined) {
  throw new Error(
    'SERVER_MODE_RUNTIME_DESCRIPTOR_REQUIRED: '
    + `no Runtime target is available for ${process.platform}/${process.arch}`
  );
}
if (target.formalRelease !== true) process.exit(0);

const pnpmScript = process.env.npm_execpath;
const result = pnpmScript === undefined
  ? spawnSync('pnpm', ['--filter', '@clawee/desktop', 'prepare:codex-runtime'], {
      cwd: repositoryRoot,
      stdio: 'inherit'
    })
  : spawnSync(process.execPath, [
      pnpmScript,
      '--filter',
      '@clawee/desktop',
      'prepare:codex-runtime'
    ], {
      cwd: repositoryRoot,
      stdio: 'inherit'
    });
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
