import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function withDevelopmentRuntime(
  sourceEnv: NodeJS.ProcessEnv,
  options: {
    repoRoot?: string;
    useProvidedDescriptor?: boolean;
  } = {}
): NodeJS.ProcessEnv {
  const repoRoot = options.repoRoot ?? resolve(
    fileURLToPath(new URL('../../../../', import.meta.url))
  );
  const dataDir = resolve(
    sourceEnv.CLAWEE_DATA_DIR ?? join(repoRoot, '.runtime')
  );
  const homePath = join(dataDir, 'codex-home');
  const env = { ...sourceEnv };
  for (const key of [
    'CODEX_BIN',
    'CLAWEE_CODEX_BIN',
    'CODEX_HOME',
    'CLAWEE_CODEX_HOME',
    'CLAWEE_CODEX_RUNTIME_DESCRIPTOR',
    'CLAWEE_CODEX_DEV_BIN',
    'CLAWEE_CODEX_DEV_HOME'
  ]) {
    delete env[key];
  }
  const providedDescriptor =
    sourceEnv.CLAWEE_CODEX_RUNTIME_DESCRIPTOR?.trim();
  if (options.useProvidedDescriptor === true) {
    if (providedDescriptor === undefined || providedDescriptor.length === 0) {
      throw new Error('WEB_E2E_RUNTIME_DESCRIPTOR_REQUIRED');
    }
    return {
      ...env,
      CLAWEE_DATA_DIR: dataDir,
      CLAWEE_DEFAULT_CWD: repoRoot,
      CLAWEE_DEFAULT_PROJECT_ROOT: repoRoot,
      CLAWEE_CODEX_RUNTIME_DESCRIPTOR: providedDescriptor
    };
  }

  const runtimeDirectory = resolve(
    repoRoot,
    'apps/desktop/.pack/codex-runtime'
  );
  const runtimeManifest = readJsonFile<{
    runtimeId: string;
    codexVersion: string;
    releaseTag: string;
    layoutVersion: number;
    minimumClaweeVersion: string;
  }>(resolve(repoRoot, 'config/codex-runtime.json'));
  const runtimePackage = readJsonFile<{
    target: string;
    entrypoint: string;
  }>(join(runtimeDirectory, 'codex-package.json'));
  const entryPath = join(runtimeDirectory, runtimePackage.entrypoint);
  return {
    ...env,
    CLAWEE_DATA_DIR: dataDir,
    CLAWEE_DEFAULT_CWD: repoRoot,
    CLAWEE_DEFAULT_PROJECT_ROOT: repoRoot,
    CLAWEE_CODEX_RUNTIME_DESCRIPTOR: JSON.stringify({
      candidate: {
        runtimeId: runtimeManifest.runtimeId,
        source: 'external-development',
        codexVersion: runtimeManifest.codexVersion,
        releaseTag: runtimeManifest.releaseTag,
        target: runtimePackage.target,
        layoutVersion: runtimeManifest.layoutVersion,
        entryPath,
        homePath,
        contentSha256: createHash('sha256')
          .update(readFileSync(entryPath))
          .digest('hex'),
        minimumClaweeVersion: runtimeManifest.minimumClaweeVersion,
        migrationSourceHome: null
      },
      previous: null,
      claweeVersion: readClaweeAppVersion()
    })
  };
}

function readClaweeAppVersion(): string {
  const manifest = readJsonFile<{ version?: unknown }>(
    new URL('../../../desktop/package.json', import.meta.url)
  );
  if (
    typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    throw new Error('Desktop package version is missing or invalid');
  }
  return manifest.version;
}

function readJsonFile<T>(path: string | URL): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
