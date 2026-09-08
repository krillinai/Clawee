import { lstatSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function removeWorkspaceSelfReference(deploymentRoot, packageName) {
  const packageSegments = packageName.split('/');
  if (
    packageSegments.length === 0
    || packageSegments.some(segment => segment.length === 0 || segment === '..')
  ) {
    throw new Error(`Invalid workspace package name: ${packageName}`);
  }

  const referencePath = join(
    resolve(deploymentRoot),
    'node_modules',
    ...packageSegments
  );
  const referenceStat = lstatSync(referencePath, { throwIfNoEntry: false });
  if (referenceStat === undefined) return undefined;
  if (!referenceStat.isSymbolicLink()) {
    throw new Error(
      `Deployed workspace self reference must be a symbolic link: ${referencePath}`
    );
  }

  rmSync(referencePath, { force: true });
  return referencePath;
}
