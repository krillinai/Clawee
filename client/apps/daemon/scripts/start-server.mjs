import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPackagedServerConfiguration
} from '../src/server-mode/config.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const daemonDirectory = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(daemonDirectory, '../..');
const args = process.argv.slice(2).filter(argument => argument !== '--');

process.chdir(repositoryRoot);
process.env.CLAWEE_CODEX_RUNTIME_DESCRIPTOR = JSON.stringify(
  createDevelopmentRuntimeDescriptor(args)
);
process.argv = [
  process.execPath,
  resolve(daemonDirectory, 'src/main.ts'),
  ...(readArgument(args, '--server-config') === undefined
    ? [`--clawee-enterprise-config=${resolve(daemonDirectory, '.runtime/config.toml')}`]
    : []),
  '--server',
  ...args
];

await import('../src/main.ts');

function createDevelopmentRuntimeDescriptor(serverArgs) {
  const runtimeDirectory = resolve(repositoryRoot, 'apps/desktop/.pack/codex-runtime');
  const manifest = readJson(resolve(repositoryRoot, 'config/codex-runtime.json'));
  const desktopPackage = readJson(resolve(repositoryRoot, 'apps/desktop/package.json'));
  const platformTarget = Object.values(manifest.targets).find(candidate =>
    candidate.platform === process.platform && candidate.arch === process.arch
  );
  if (platformTarget === undefined) {
    throw new Error(
      'SERVER_MODE_RUNTIME_DESCRIPTOR_REQUIRED: '
      + `no Runtime target is available for ${process.platform}/${process.arch}`
    );
  }
  const externalRuntime = platformTarget.formalRelease !== true;
  const runtime = externalRuntime
    ? readExternalRuntime(platformTarget)
    : {
        ...readBundledRuntime(runtimeDirectory, platformTarget),
        version: manifest.codexVersion
      };
  const validatedVersion = runtime.version === manifest.codexVersion;
  if (externalRuntime && !validatedVersion) {
    console.warn(JSON.stringify({
      event: 'SERVER_MODE_CODEX_VERSION_UNVALIDATED',
      actualVersion: runtime.version,
      validatedVersion: manifest.codexVersion,
      message: "External Codex version has not passed this release's compatibility gates"
    }));
  }
  const dataDir = readServerDataDirectory(serverArgs);
  const homePath = join(dataDir, 'codex-home');
  return {
    candidate: {
      runtimeId: validatedVersion
        ? manifest.runtimeId
        : `codex-external-v${runtime.version}-layout-${manifest.layoutVersion}`,
      source: 'external-development',
      codexVersion: runtime.version,
      releaseTag: validatedVersion
        ? manifest.releaseTag
        : `rust-v${runtime.version}`,
      target: runtime.target,
      layoutVersion: manifest.layoutVersion,
      entryPath: runtime.entryPath,
      homePath,
      contentSha256: createHash('sha256')
        .update(readFileSync(runtime.entryPath))
        .digest('hex'),
      minimumClaweeVersion: manifest.minimumClaweeVersion,
      migrationSourceHome: null
    },
    previous: null,
    claweeVersion: desktopPackage.version
  };
}

function readServerDataDirectory(serverArgs) {
  const configPath = readArgument(serverArgs, '--server-config');
  if (configPath !== undefined) {
    return readPackagedServerConfiguration(
      resolve(repositoryRoot, configPath)
    ).dataDir;
  }
  return resolve(
    repositoryRoot,
    readArgument(serverArgs, '--data-dir') ?? '.runtime'
  );
}

function readBundledRuntime(runtimeDirectory, platformTarget) {
  const runtimePackage = readJson(join(runtimeDirectory, 'codex-package.json'));
  if (runtimePackage.target !== platformTarget.targetTriple) {
    throw new Error(
      'SERVER_MODE_RUNTIME_DESCRIPTOR_REQUIRED: '
      + `bundled Runtime target ${runtimePackage.target} does not match `
      + platformTarget.targetTriple
    );
  }
  return {
    target: runtimePackage.target,
    entryPath: join(runtimeDirectory, runtimePackage.entrypoint)
  };
}

function readExternalRuntime(platformTarget) {
  if (process.platform !== 'linux') {
    throw new Error(
      'SERVER_MODE_RUNTIME_DESCRIPTOR_REQUIRED: '
      + `no formal bundled Runtime is available for ${process.platform}/${process.arch}`
    );
  }
  const entryPath = findExecutable('codex');
  const versionResult = spawnSync(entryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000
  });
  const output = `${versionResult.stdout ?? ''}\n${versionResult.stderr ?? ''}`;
  if (versionResult.error !== undefined || versionResult.status !== 0) {
    throw new Error(
      'SERVER_MODE_CODEX_VERSION_UNAVAILABLE: '
      + 'failed to read the external Codex version'
    );
  }
  const version = output.match(
    /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/
  )?.[1];
  if (version === undefined) {
    throw new Error(
      'SERVER_MODE_CODEX_VERSION_INVALID: '
      + 'external Codex returned an unsupported version string'
    );
  }
  return {
    target: platformTarget.targetTriple,
    entryPath,
    version
  };
}

function findExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory || process.cwd(), name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`SERVER_MODE_CODEX_NOT_FOUND: ${name}`);
}

function readArgument(args, name) {
  const match = args.find(argument => argument.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
