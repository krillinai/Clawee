import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  removeWorkspaceSelfReference,
  pruneDaemonBuildArtifacts
} from '../scripts/daemon-deployment-contract.mjs';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Daemon deployment contract', () => {
  it('prunes build-only files while preserving SQLite and OfficeParser Node entrypoints', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-daemon-prune-'));
    tempRoots.push(root);
    const sqliteBuild = join(root, 'node_modules', 'better-sqlite3', 'build');
    const sqliteRelease = join(sqliteBuild, 'Release');
    const officeDist = join(root, 'node_modules', 'officeparser', 'dist');
    mkdirSync(sqliteRelease, { recursive: true });
    mkdirSync(officeDist, { recursive: true });
    const binaryPath = join(sqliteRelease, 'better_sqlite3.node');
    const binary = Buffer.from([0, 1, 2, 255]);
    writeFileSync(binaryPath, binary, { mode: 0o755 });
    const binaryMode = statSync(binaryPath).mode & 0o777;
    writeFileSync(join(sqliteRelease, 'sqlite3.a'), 'build-only');
    writeFileSync(join(sqliteRelease, 'test_extension.node'), 'test-only');
    writeFileSync(join(sqliteBuild, 'Makefile'), 'build-only');
    for (const name of ['index.js', 'index.mjs', 'officeparser.browser.mjs', 'officeparser.browser.slim.iife.js']) {
      writeFileSync(join(officeDist, name), name);
    }

    pruneDaemonBuildArtifacts(root);
    pruneDaemonBuildArtifacts(root);

    expect(readFileSync(binaryPath)).toEqual(binary);
    expect(statSync(binaryPath).mode & 0o777).toBe(binaryMode);
    expect(existsSync(join(sqliteRelease, 'sqlite3.a'))).toBe(false);
    expect(existsSync(join(sqliteRelease, 'test_extension.node'))).toBe(false);
    expect(existsSync(join(sqliteBuild, 'Makefile'))).toBe(false);
    expect(readFileSync(join(officeDist, 'index.js'), 'utf8')).toBe('index.js');
    expect(readFileSync(join(officeDist, 'index.mjs'), 'utf8')).toBe('index.mjs');
    expect(existsSync(join(officeDist, 'officeparser.browser.mjs'))).toBe(false);
    expect(existsSync(join(officeDist, 'officeparser.browser.slim.iife.js'))).toBe(false);
  });

  it('removes the deployed workspace self-reference without touching its target', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-daemon-deploy-'));
    tempRoots.push(root);
    const sourceRoot = join(root, 'source-daemon');
    const deploymentRoot = join(root, 'deployment');
    const referenceRoot = join(
      deploymentRoot,
      'node_modules',
      '@clawee'
    );
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(referenceRoot, { recursive: true });
    const referencePath = join(referenceRoot, 'daemon');
    symlinkSync(
      sourceRoot,
      referencePath,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    expect(
      removeWorkspaceSelfReference(deploymentRoot, '@clawee/daemon')
    ).toBe(referencePath);
    expect(existsSync(referencePath)).toBe(false);
    expect(existsSync(sourceRoot)).toBe(true);
  });

  it('rejects a copied package at the self-reference path', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-daemon-deploy-'));
    tempRoots.push(root);
    const deploymentRoot = join(root, 'deployment');
    mkdirSync(
      join(deploymentRoot, 'node_modules', '@clawee', 'daemon'),
      { recursive: true }
    );

    expect(() => {
      removeWorkspaceSelfReference(deploymentRoot, '@clawee/daemon');
    }).toThrow(/must be a symbolic link/);
  });
});
