import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  removeWorkspaceSelfReference
} from '../scripts/daemon-deployment-contract.mjs';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Daemon deployment contract', () => {
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
