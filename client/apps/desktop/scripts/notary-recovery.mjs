import assert from 'node:assert/strict';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync,
  renameSync, rmSync, writeFileSync
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as tar from 'tar';
import { hashFile } from './directory-integrity.mjs';

export const checkpointFilename = 'notary-recovery.json';
const contextFilename = 'verification-context.tar.gz';
const contextRoots = ['apps/web/dist', 'apps/desktop/.pack/codex-runtime'];

export async function describeReleaseArtifacts(paths, rootDir) {
  return Promise.all(paths.map(async path => ({
    path,
    relativePath: relative(rootDir, path),
    bytes: lstatSync(path).size,
    sha256: await hashFile(path)
  })));
}

export async function createNotaryRecovery({ directory, rootDir, manifest, teamId }) {
  assert.equal(manifest.mode, 'release');
  assert.equal(manifest.dirty, false);
  mkdirSync(directory, { recursive: true });
  const contextPath = join(directory, contextFilename);
  await tar.c({ file: contextPath, cwd: rootDir, gzip: true }, contextRoots);
  const recovery = {
    directory, rootDir,
    artifactPaths: manifest.artifacts.map(artifact => artifact.path),
    checkpoint: {
      schemaVersion: 1,
      kind: 'clawee-macos-notary-recovery',
      source: {
        repository: process.env.GITHUB_REPOSITORY ?? null,
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null
      },
      tag: `v${manifest.releaseVersion}`,
      teamId,
      stage: 'built',
      submission: { state: 'not-submitted', id: null },
      manifest,
      context: {
        name: contextFilename,
        bytes: lstatSync(contextPath).size,
        sha256: await hashFile(contextPath)
      }
    }
  };
  await saveNotaryRecovery(recovery);
  return recovery;
}

export async function saveNotaryRecovery(recovery, changes = {}) {
  Object.assign(recovery.checkpoint, changes);
  const artifacts = await describeReleaseArtifacts(recovery.artifactPaths, recovery.rootDir);
  for (const artifact of artifacts) {
    const target = join(recovery.directory, basename(artifact.path));
    const previous = recovery.checkpoint.files?.find(file => file.name === basename(target));
    if (!previous || previous.sha256 !== artifact.sha256 || !existsSync(target)) {
      cpSync(artifact.path, target);
    }
  }
  recovery.checkpoint.manifest.artifacts = artifacts;
  recovery.checkpoint.files = artifacts.map(artifact => ({
    name: basename(artifact.path), bytes: artifact.bytes, sha256: artifact.sha256
  }));
  recovery.checkpoint.updatedAt = new Date().toISOString();
  const path = join(recovery.directory, checkpointFilename);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(recovery.checkpoint, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

export function notaryFailureDiagnostic(error, env = process.env) {
  let message = String(error?.message ?? error);
  for (const name of [
    'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY',
    'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'CSC_LINK', 'CSC_KEY_PASSWORD',
    'MACOS_CERTIFICATE', 'MACOS_CERTIFICATE_PASSWORD', 'GH_TOKEN', 'GITHUB_TOKEN'
  ]) {
    if (env[name]) {
      for (const value of new Set([env[name], env[name].trim()])) {
        if (value) message = message.split(value).join('***');
      }
    }
  }
  return { message };
}

export async function loadNotaryRecovery(directory, expected) {
  const checkpoint = JSON.parse(readFileSync(join(directory, checkpointFilename), 'utf8'));
  assert.equal(checkpoint.schemaVersion, 1, '不支持的公证恢复检查点');
  assert.equal(checkpoint.kind, 'clawee-macos-notary-recovery');
  assert.match(expected.sha ?? '', /^[0-9a-f]{40}$/);
  assert.match(expected.tag ?? '', /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.match(expected.runId ?? '', /^\d+$/);
  assert.match(expected.runAttempt ?? '', /^\d+$/);
  assert.match(expected.repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert(['arm64', 'x64'].includes(expected.arch));
  assert.equal(typeof expected.teamId, 'string');
  assert(expected.teamId.length > 0);
  assert.equal(checkpoint.source.repository, expected.repository, '恢复仓库不匹配');
  assert.equal(checkpoint.source.runId, expected.runId, '恢复来源任务不匹配');
  assert.equal(checkpoint.source.runAttempt, expected.runAttempt, '恢复来源执行次数不匹配');
  assert.equal(checkpoint.tag, expected.tag, '恢复标签不匹配');
  assert.equal(checkpoint.teamId, expected.teamId, '恢复签名 Team 不匹配');
  const manifest = checkpoint.manifest;
  assert.equal(manifest.version, 2);
  assert.equal(manifest.commit, expected.sha, '恢复源码 SHA 不匹配');
  assert.equal(manifest.releaseVersion, expected.tag.slice(1));
  assert.equal(manifest.dirty, false, '不能恢复非干净源码构建');
  assert.equal(manifest.mode, 'release', '不能恢复未签名构建');
  assert.equal(manifest.platform, 'darwin');
  assert.equal(manifest.arch, expected.arch, '恢复架构不匹配');
  assert(['built', 'submit', 'accepted', 'staple', 'validate', 'gatekeeper', 'package', 'verified'].includes(checkpoint.stage));
  assert(['not-submitted', 'submitting', 'submitted'].includes(checkpoint.submission.state));
  if (checkpoint.submission.state === 'submitting') {
    throw new Error('公证上传结果不明确且没有提交 ID，拒绝恢复以避免重复上传');
  }
  if (checkpoint.submission.state === 'submitted') {
    assert.match(checkpoint.submission.id ?? '', /^[0-9a-f-]{36}$/i);
  } else {
    assert.equal(checkpoint.submission.id, null);
    assert.equal(checkpoint.stage, 'built');
  }
  const suffix = expected.arch === 'arm64' ? '-arm64' : '';
  const installers = [
    `Clawee-${manifest.releaseVersion}${suffix}.dmg`,
    `Clawee-${manifest.releaseVersion}${suffix}-mac.zip`
  ];
  const allowed = new Set([
    ...installers, ...installers.map(name => `${name}.blockmap`), 'latest-mac.yml'
  ]);
  assert(Array.isArray(checkpoint.files));
  const names = checkpoint.files.map(file => file.name);
  assert.equal(new Set(names).size, names.length, '恢复文件重复');
  for (const name of [...installers, 'latest-mac.yml']) assert(names.includes(name), `恢复文件缺失：${name}`);
  for (const file of checkpoint.files) {
    assert(allowed.has(file.name), `恢复文件不在允许列表：${file.name}`);
    await verifyRecoveryFile(directory, file);
  }
  assert.equal(checkpoint.context.name, contextFilename);
  await verifyRecoveryFile(directory, checkpoint.context);
  assert.equal(manifest.artifacts.length, checkpoint.files.length);
  for (const file of checkpoint.files) {
    const matches = manifest.artifacts.filter(artifact => basename(artifact.relativePath) === file.name);
    assert.equal(matches.length, 1, '恢复清单文件不匹配');
    assert.equal(matches[0].bytes, file.bytes);
    assert.equal(matches[0].sha256, file.sha256);
  }
  return checkpoint;
}

async function verifyRecoveryFile(directory, file) {
  assert.equal(basename(file.name), file.name, '恢复路径不能跨目录');
  const path = join(directory, file.name);
  assert(lstatSync(path).isFile(), '恢复文件不能是符号链接或目录');
  assert.equal(lstatSync(path).size, file.bytes, `恢复文件大小不匹配：${file.name}`);
  assert.match(file.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(await hashFile(path), file.sha256, `恢复文件哈希不匹配：${file.name}`);
}

export async function restoreVerificationContext(directory, rootDir) {
  const allowedEntry = (path, type) => {
    const normalized = path.replace(/\/$/, '');
    return !normalized.split('/').includes('..')
      && contextRoots.some(root => normalized === root || normalized.startsWith(`${root}/`))
      && ['File', 'Directory'].includes(type);
  };
  let invalidEntry;
  await tar.t({
    file: join(directory, contextFilename), strict: true,
    onReadEntry(entry) {
      if (!allowedEntry(entry.path, entry.type)) invalidEntry ??= entry.path;
    }
  });
  assert.equal(invalidEntry, undefined, `恢复归档包含非验证文件或链接：${invalidEntry}`);
  for (const root of contextRoots) rmSync(join(rootDir, root), { force: true, recursive: true });
  await tar.x({
    file: join(directory, contextFilename), cwd: rootDir, strict: true,
    filter(path, entry) {
      return allowedEntry(path, entry.type);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], 'diagnose');
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../release/notary-recovery');
  mkdirSync(directory, { recursive: true });
  if (!existsSync(join(directory, checkpointFilename))) {
    writeFileSync(join(directory, 'diagnostic.json'), `${JSON.stringify({
      recoverable: false,
      reason: 'App 公证或安装包构建未完成，缺少可恢复检查点；请查看原任务日志',
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      commit: process.env.SOURCE_SHA,
      arch: process.env.CLAWEE_DESKTOP_TARGET_ARCH
    }, null, 2)}\n`);
  }
}
