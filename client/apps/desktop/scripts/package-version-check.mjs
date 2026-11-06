import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseReleaseVersion } from '../../../../scripts/version.mjs';

export function assertLocalPackageVersion(repositoryRoot) {
  const version = parseReleaseVersion(readFileSync(join(repositoryRoot, 'VERSION'), 'utf8').trim());
  const tags = gitTags(repositoryRoot, '--merged', 'HEAD');
  const exactTags = gitTags(repositoryRoot, '--points-at', 'HEAD').filter(tag => releaseTag(tag) !== undefined);
  for (const tag of exactTags) {
    if (tag !== version.tag) {
      throw new Error(`desktop:package: VERSION ${version.version} 与当前提交的 Tag ${tag} 不一致；请使用匹配的源码版本`);
    }
  }

  const latestStableTag = tags.filter(tag => releaseTag(tag)?.prerelease === false)
    .sort((left, right) => compareStableTags(right, left))[0];
  if (latestStableTag !== undefined && compareToStableTag(version, latestStableTag) < 0) {
    throw new Error(`desktop:package: VERSION ${version.version} 低于当前分支已发布的 ${latestStableTag}；请先更新 VERSION`);
  }
}

function gitTags(repositoryRoot, ...args) {
  const result = spawnSync('git', ['tag', ...args, '--list', 'v*'], {
    cwd: repositoryRoot, encoding: 'utf8', timeout: 10_000
  });
  if (result.status !== 0) throw new Error(`desktop:package: 无法读取 Git 标签：${result.stderr.trim()}`);
  return result.stdout.trim().split('\n').filter(Boolean);
}

function releaseTag(tag) {
  try {
    return tag.startsWith('v') ? parseReleaseVersion(tag.slice(1)) : undefined;
  } catch {
    return undefined;
  }
}

function compareStableTags(left, right) {
  const leftParts = left.slice(1).split('.');
  const rightParts = right.slice(1).split('.');
  for (let index = 0; index < 3; index += 1) {
    const a = BigInt(leftParts[index]);
    const b = BigInt(rightParts[index]);
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

function compareToStableTag(version, tag) {
  const baseVersion = `v${version.version.split('-')[0]}`;
  const difference = compareStableTags(baseVersion, tag);
  return difference === 0 && version.prerelease ? -1 : difference;
}
