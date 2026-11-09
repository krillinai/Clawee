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
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  materializeLazystreamDependency,
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
  it('keeps lazystream on its own readable-stream version when copying junctions', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-daemon-stream-'));
    tempRoots.push(root);
    const modules = join(root, 'node_modules');
    const lazyStore = join(modules, '.pnpm', 'lazystream', 'node_modules');
    const streamStore = join(modules, '.pnpm', 'readable-stream-2', 'node_modules');
    const lazyPackage = join(lazyStore, 'lazystream');
    const streamPackage = join(streamStore, 'readable-stream');
    mkdirSync(lazyPackage, { recursive: true });
    mkdirSync(streamPackage, { recursive: true });
    mkdirSync(join(modules, 'readable-stream'), { recursive: true });
    writeFileSync(join(lazyPackage, 'package.json'), JSON.stringify({ name: 'lazystream', main: 'index.js' }));
    writeFileSync(join(lazyPackage, 'index.js'), `module.exports = require('readable-stream/passthrough')`);
    writeFileSync(join(streamPackage, 'passthrough.js'), 'module.exports = 2');
    symlinkSync(lazyPackage, join(modules, 'lazystream'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(streamPackage, join(lazyStore, 'readable-stream'), process.platform === 'win32' ? 'junction' : 'dir');

    const requireFromRoot = createRequire(join(root, 'package.json'));
    expect(requireFromRoot('lazystream')).toBe(2);
    materializeLazystreamDependency(root);
    expect(requireFromRoot('lazystream')).toBe(2);
    expect(statSync(join(modules, 'lazystream', 'node_modules', 'readable-stream', 'passthrough.js')).isFile()).toBe(true);
  });

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
