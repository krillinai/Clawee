import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const rootDir = resolve(desktopDir, '../..');
const pnpmScript = process.env.npm_execpath;
const pnpmCommand = pnpmScript === undefined ? 'pnpm' : process.execPath;
const pnpmArgs = args => pnpmScript === undefined ? args : [pnpmScript, ...args];
const daemonDir = resolve(rootDir, 'apps/daemon');
const developmentDaemonDir = resolve(desktopDir, '.pack/daemon');
const developmentDaemonMarker = resolve(
  desktopDir,
  '.cache/development-daemon.json'
);
const developmentCodexRuntimeDir = resolve(
  desktopDir,
  '.pack/codex-runtime'
);
const developmentCodexHome = resolve(
  desktopDir,
  '.runtime/codex-home'
);
const webDevelopmentPort = 19_860;
let webProcess;

try {
  await prepareDevelopmentCodexRuntime();
  const preparedDaemon = await ensureDevelopmentDaemonRuntime();
  if (!preparedDaemon) {
    await run(
      pnpmCommand,
      pnpmArgs(['--filter', '@clawee/daemon', 'build']),
      rootDir
    );
  }
  syncDevelopmentDaemonDist();
  await run(
    pnpmCommand,
    pnpmArgs(['--filter', '@clawee/desktop', 'build']),
    rootDir
  );
  if (!(await isPortOpen(webDevelopmentPort))) {
    webProcess = spawn(pnpmCommand, pnpmArgs(['--filter', '@clawee/web', 'dev']), {
      cwd: rootDir,
      env: {
        ...process.env,
        CLAWEE_WEB_DESKTOP_HOSTED: '1'
      },
      stdio: 'inherit'
    });
    await waitForPort(webDevelopmentPort, 30_000);
  }
  const electronEnv = {
    ...process.env
  };
  for (const key of [
    'CODEX_BIN',
    'CLAWEE_CODEX_BIN',
    'CODEX_HOME',
    'CLAWEE_CODEX_HOME',
    'CLAWEE_CODEX_RUNTIME_DESCRIPTOR',
    'CLAWEE_CODEX_DEV_BIN',
    'CLAWEE_CODEX_DEV_HOME'
  ]) {
    delete electronEnv[key];
  }
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const code = await run(electron, ['.'], desktopDir, electronEnv);
  process.exitCode = code;
} finally {
  webProcess?.kill('SIGTERM');
}

async function prepareDevelopmentCodexRuntime() {
  await run(
    pnpmCommand,
    pnpmArgs(['--filter', '@clawee/desktop', 'prepare:codex-runtime']),
    rootDir
  );
  mkdirSync(developmentCodexHome, { recursive: true });
}

async function ensureDevelopmentDaemonRuntime() {
  const fingerprint = developmentDaemonFingerprint();
  const requiredPaths = [
    resolve(developmentDaemonDir, 'dist/main.js'),
    resolve(
      developmentDaemonDir,
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
    )
  ];
  const marker = readJson(developmentDaemonMarker);
  if (
    marker?.fingerprint === fingerprint
    && requiredPaths.every(path => existsSync(path))
  ) {
    return false;
  }

  if (
    requiredPaths.every(path => existsSync(path))
    && runtimeDependenciesAreFresh(requiredPaths[1])
  ) {
    writeDevelopmentDaemonMarker(fingerprint);
    return false;
  }

  await run(
    pnpmCommand,
    pnpmArgs(['--filter', '@clawee/desktop', 'prepare:daemon']),
    rootDir
  );
  writeDevelopmentDaemonMarker(fingerprint);
  return true;
}

function syncDevelopmentDaemonDist() {
  const source = resolve(daemonDir, 'dist');
  const target = resolve(developmentDaemonDir, 'dist');
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

function developmentDaemonFingerprint() {
  const hash = createHash('sha256');
  for (const path of developmentDaemonInputs()) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  hash.update(`${process.platform}:${process.arch}`);
  return hash.digest('hex');
}

function developmentDaemonInputs() {
  return [
    resolve(rootDir, 'pnpm-lock.yaml'),
    resolve(daemonDir, 'package.json'),
    resolve(desktopDir, 'package.json'),
    resolve(desktopDir, 'scripts/prepare-daemon.mjs')
  ];
}

function runtimeDependenciesAreFresh(nativeModulePath) {
  const preparedAt = statSync(nativeModulePath).mtimeMs;
  return developmentDaemonInputs().every(
    path => statSync(path).mtimeMs <= preparedAt
  );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeDevelopmentDaemonMarker(fingerprint) {
  mkdirSync(dirname(developmentDaemonMarker), { recursive: true });
  writeFileSync(
    developmentDaemonMarker,
    `${JSON.stringify({ fingerprint }, null, 2)}\n`
  );
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => resolvePromise(code ?? 1));
  }).then(code => {
    if (code !== 0) throw new Error(`${command} exited with code ${code}`);
    return code;
  });
}

function isPortOpen(port) {
  return new Promise(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(250);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    const close = () => {
      socket.destroy();
      resolvePromise(false);
    };
    socket.once('timeout', close);
    socket.once('error', close);
  });
}

async function waitForPort(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port)) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Timed out waiting for 127.0.0.1:${port}`);
}
