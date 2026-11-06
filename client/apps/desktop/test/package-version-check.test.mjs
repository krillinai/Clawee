import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'vitest';
import { assertLocalPackageVersion } from '../scripts/package-version-check.mjs';

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(directory, ...args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function repo(version, tag = 'v1.0.17') {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-package-version-'));
  directories.push(directory);
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.name', 'Test');
  git(directory, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(directory, 'VERSION'), `${version}\n`);
  git(directory, 'add', 'VERSION');
  git(directory, 'commit', '-qm', 'version');
  git(directory, 'tag', tag);
  return directory;
}

describe('local Desktop directory package version', () => {
  it('rejects a VERSION different from the tag on HEAD', () => {
    const directory = repo('1.0.15');
    assert.throws(() => assertLocalPackageVersion(directory), /VERSION 1\.0\.15.*v1\.0\.17/);
  });

  it('accepts an exact matching tag', () => {
    const directory = repo('1.0.17');
    assert.doesNotThrow(() => assertLocalPackageVersion(directory));
  });

  it('requires an exact match on a prerelease tag too', () => {
    const directory = repo('1.0.17');
    writeFileSync(join(directory, 'VERSION'), '1.0.18-rc.1\n');
    git(directory, 'add', 'VERSION');
    git(directory, 'commit', '-qm', 'release candidate');
    git(directory, 'tag', 'v1.0.18-rc.1');
    assert.doesNotThrow(() => assertLocalPackageVersion(directory));
    writeFileSync(join(directory, 'VERSION'), '1.0.18\n');
    assert.throws(() => assertLocalPackageVersion(directory), /VERSION 1\.0\.18.*v1\.0\.18-rc\.1/);
  });

  it('rejects a stale VERSION on an untagged commit and allows the next release version', () => {
    const directory = repo('1.0.17');
    git(directory, 'commit', '--allow-empty', '-qm', 'work after tag');
    writeFileSync(join(directory, 'VERSION'), '1.0.15\n');
    assert.throws(() => assertLocalPackageVersion(directory), /VERSION 1\.0\.15.*v1\.0\.17/);
    writeFileSync(join(directory, 'VERSION'), '1.0.18\n');
    assert.doesNotThrow(() => assertLocalPackageVersion(directory));
  });

  it('does not select unrelated branch tags or prerelease tags as the stable baseline', () => {
    const directory = repo('1.0.17');
    git(directory, 'commit', '--allow-empty', '-qm', 'next');
    git(directory, 'tag', 'v1.0.18-rc.1');
    git(directory, 'commit', '--allow-empty', '-qm', 'after candidate');
    git(directory, 'branch', 'other');
    git(directory, 'checkout', '-q', 'other');
    git(directory, 'commit', '--allow-empty', '-qm', 'other release');
    git(directory, 'tag', 'v9.0.0');
    git(directory, 'checkout', '-q', '-');
    assert.doesNotThrow(() => assertLocalPackageVersion(directory));
  });
});
