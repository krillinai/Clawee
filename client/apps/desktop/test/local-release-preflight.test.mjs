import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = resolve(process.cwd(), '../..');
const rootPackage = JSON.parse(readFileSync(
  resolve(rootDir, 'package.json'),
  'utf8'
));
const localPreflightPath = resolve(
  rootDir,
  'scripts/desktop-local-preflight.mjs'
);
const tagCheckPath = resolve(rootDir, 'scripts/desktop-tag-check.mjs');
const localPreflight = readFileSync(localPreflightPath, 'utf8');
const tagCheck = readFileSync(tagCheckPath, 'utf8');
const agentRules = readFileSync(resolve(rootDir, '../AGENTS.md'), 'utf8');

describe('Desktop local release preflight', () => {
  it('exposes explicit local, release, and tag-check commands', () => {
    expect(rootPackage.scripts).toMatchObject({
      'desktop:preflight:local':
        'node scripts/desktop-local-preflight.mjs',
      'desktop:preflight:release':
        'node scripts/desktop-local-preflight.mjs --release',
      'desktop:tag:check': 'node scripts/desktop-tag-check.mjs'
    });
  });

  it('validates the repository and a real packaged App locally', () => {
    expect(localPreflight).toContain("args: ['codex:runtime:verify']");
    expect(localPreflight).toContain("args: ['test']");
    expect(localPreflight).toContain("args: ['typecheck']");
    expect(localPreflight).toContain("args: ['desktop:package']");
    expect(localPreflight).toContain(
      "args: ['--filter', '@clawee/desktop', 'e2e:embedded-runtime']"
    );
    expect(localPreflight).toContain("args: ['desktop:release:doctor']");
    expect(localPreflight).toContain(
      'clawee-desktop-local-preflight.json'
    );
  });

  it('checks evidence and remote status without creating a tag or workflow run', () => {
    expect(tagCheck).toContain(
      'Desktop tag check requires a clean Git worktree'
    );
    expect(tagCheck).toContain("gitOutput(['rev-parse', '@{upstream}'])");
    expect(tagCheck).toContain('release-preflight');
    expect(tagCheck).toContain('releaseReady !== true');
    expect(tagCheck).toContain('release tags are immutable');
    expect(tagCheck).toContain("commandOutput('pnpm', ['desktop:release:doctor']");
    expect(tagCheck).not.toContain("spawnSync('git', ['tag'");
    expect(tagCheck).not.toContain('gh workflow run');
  });

  it('documents GitHub Actions cost controls as project-level rules', () => {
    expect(agentRules).toContain('desktop:preflight:local');
    expect(agentRules).toContain('desktop:preflight:release');
    expect(agentRules).toContain('desktop:tag:check');
    expect(agentRules).toContain('不得将远端打包用于反复试错');
    expect(agentRules).toContain('运行远端发布前，报告本地结果、目标 SHA 和 workflow 次数');
  });

  it('provides side-effect-free help for both commands', () => {
    for (const script of [localPreflightPath, tagCheckPath]) {
      const result = spawnSync(process.execPath, [script, '--help'], {
        cwd: rootDir,
        encoding: 'utf8'
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Usage:');
    }
  });

  it('accepts the pnpm argument separator before a tag', () => {
    expect(tagCheck).toContain(
      "process.argv.slice(2).filter(arg => arg !== '--')"
    );
  });
});
