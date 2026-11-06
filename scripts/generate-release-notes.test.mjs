import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderReleaseNotes } from './generate-release-notes.mjs';

const template = readFileSync(new URL('../.github/release-notes-template.md', import.meta.url), 'utf8');

function manifest(version = '1.2.3-rc.1') {
  return {
    version,
    tag: `v${version}`,
    desktop: { windowsSigning: 'unsigned' },
    artifacts: [
      `Clawee-Setup-${version}.exe`,
      `Clawee-${version}-arm64.dmg`,
      `Clawee-${version}.dmg`,
      `clawee-server-v${version}-linux-amd64.tar.gz`,
      `clawee-server-v${version}-linux-arm64.tar.gz`
    ].map(name => ({ name }))
  };
}

test('渲染官网、各平台下载链接和自动变更记录', () => {
  const input = {
    manifest: manifest(),
    generatedNotes: '**Full Changelog**: https://github.com/krillinai/Clawee/compare/v1.2.2...v1.2.3-rc.1\n',
    repository: 'krillinai/Clawee',
    template
  };
  const notes = renderReleaseNotes(input);
  assert.match(notes, /^<!-- clawee-downloads:start -->\r?\n官网：https:\/\/www\.clawee\.work\//);
  for (const artifact of input.manifest.artifacts) {
    assert.ok(notes.includes(`https://github.com/krillinai/Clawee/releases/download/v1.2.3-rc.1/${artifact.name}`));
  }
  assert.doesNotMatch(notes, /平台说明|Authenticode/);
  assert.match(notes, /\*\*Full Changelog\*\*:/);
  assert.equal(renderReleaseNotes({ ...input, generatedNotes: notes }), notes);
});

test('缺少平台安装包时中止', () => {
  const input = {
    manifest: manifest('2.0.0'),
    generatedNotes: '版本变更记录',
    repository: 'krillinai/Clawee',
    template
  };
  input.manifest.artifacts.pop();
  assert.throws(() => renderReleaseNotes(input), /linux-arm64\.tar\.gz/);
});

test('仅客户端版本不要求或展示 Linux 服务端下载', () => {
  const release = manifest('1.0.6');
  release.components = ['desktop'];
  release.artifacts = release.artifacts.filter(item => !item.name.startsWith('clawee-server-'));
  const input = { manifest: release, generatedNotes: '客户端更新', repository: 'krillinai/ClaweePro', template };
  const notes = renderReleaseNotes(input);
  assert.doesNotMatch(notes, /clawee-server-|Linux/);
  for (const item of release.artifacts) assert.ok(notes.includes(item.name));
  release.artifacts.pop();
  assert.throws(() => renderReleaseNotes(input), /missing/);
});
