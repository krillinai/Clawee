import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const commonJsPackageScope = {
  private: true,
  type: 'commonjs'
};

export function ensureElectronBuilderCacheScope(cacheRoot) {
  const resolvedCacheRoot = resolve(cacheRoot);
  const packagePath = join(resolvedCacheRoot, 'package.json');
  mkdirSync(resolvedCacheRoot, { recursive: true });
  writeFileSync(
    packagePath,
    `${JSON.stringify(commonJsPackageScope, null, 2)}\n`
  );

  const packageConfig = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (packageConfig.type !== 'commonjs') {
    throw new Error(
      `Electron Builder cache must use a CommonJS package scope: ${packagePath}`
    );
  }

  return {
    cacheRoot: resolvedCacheRoot,
    packagePath
  };
}
