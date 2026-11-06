import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseReleaseVersion } from './version.mjs';

const downloadGuide = /^<!-- clawee-downloads:start -->[\s\S]*?<!-- clawee-downloads:end -->\s*/;

export function renderReleaseNotes({ manifest, generatedNotes, repository, template }) {
  const release = parseReleaseVersion(manifest.version);
  if (manifest.tag !== release.tag) {
    throw new Error(`Release tag ${manifest.tag} does not match ${release.tag}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  const version = release.version;
  const desktopOnly = manifest.components?.length === 1 && manifest.components[0] === 'desktop';
  const downloads = [
    ['Windows x64', `Clawee-Setup-${version}.exe`],
    ['macOS（Apple 芯片 / arm64）', `Clawee-${version}-arm64.dmg`],
    ['macOS（Intel / x64）', `Clawee-${version}.dmg`],
    ...(desktopOnly ? [] : [
      ['Linux x64（自托管服务端）', `clawee-server-${release.tag}-linux-amd64.tar.gz`],
      ['Linux arm64（自托管服务端）', `clawee-server-${release.tag}-linux-arm64.tar.gz`]
    ])
  ];
  const artifactNames = new Set(manifest.artifacts.map(artifact => artifact.name));
  for (const [, name] of downloads) {
    if (!artifactNames.has(name)) throw new Error(`Release download artifact is missing: ${name}`);
  }
  const table = [
    '| 平台 | 推荐下载 |',
    '| --- | --- |',
    ...downloads.map(([platform, name]) =>
      `| ${platform} | [${name}](https://github.com/${repository}/releases/download/${release.tag}/${name}) |`
    )
  ].join('\n');
  const guide = template
    .replace('{{DOWNLOADS}}', table)
    .replace('{{SERVER_NOTE}}', desktopOnly ? '' : 'Linux 压缩包用于部署服务端，不是桌面安装包。')
    .trim();
  const changelog = generatedNotes.replace(downloadGuide, '').trim();
  return `${guide}${changelog ? `\n\n${changelog}` : ''}\n`;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requiredOption(args, name) {
  const value = readOption(args, name);
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function runCli() {
  const args = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(requiredOption(args, '--manifest'), 'utf8'));
  const generatedNotes = readFileSync(requiredOption(args, '--generated'), 'utf8');
  const template = readFileSync(new URL('../.github/release-notes-template.md', import.meta.url), 'utf8');
  const output = renderReleaseNotes({
    manifest,
    generatedNotes,
    repository: requiredOption(args, '--repository'),
    template
  });
  writeFileSync(requiredOption(args, '--output'), output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli();
}
