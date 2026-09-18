import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function pruneDaemonBuildArtifacts(deploymentRoot) {
  const sqliteBuild = join(deploymentRoot, 'node_modules', 'better-sqlite3', 'build');
  const sqliteRelease = join(sqliteBuild, 'Release');
  const binaryPath = join(sqliteRelease, 'better_sqlite3.node');
  const binary = readFileSync(binaryPath);
  const mode = statSync(binaryPath).mode & 0o777;
  rmSync(sqliteBuild, { recursive: true, force: true });
  mkdirSync(sqliteRelease, { recursive: true });
  writeFileSync(binaryPath, binary, { mode });

  // daemon 只加载 OfficeParser 的 Node 入口，不分发独立浏览器 bundle。
  const officeDist = join(deploymentRoot, 'node_modules', 'officeparser', 'dist');
  for (const entry of readdirSync(officeDist, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('officeparser.browser.')
      && /\.(?:js|mjs)$/.test(entry.name)) {
      rmSync(join(officeDist, entry.name));
    }
  }
}

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
