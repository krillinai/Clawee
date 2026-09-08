import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';

const { parse, stringify } = createRequire(new URL('../../daemon/package.json', import.meta.url))('yaml');

export function collectUpdateArtifacts(directory, startedAt, platform) {
  const files = readdirSync(directory)
    .filter(name => /\.(dmg|zip|exe|blockmap)$/.test(name) || /^latest.*\.yml$/.test(name))
    .map(name => join(directory, name))
    .filter(path => statSync(path).isFile() && statSync(path).mtimeMs >= startedAt - 2_000)
    .sort();
  const extension = platform === 'darwin' ? '.dmg' : '.exe';
  if (files.filter(path => path.endsWith(extension)).length !== 1
    || (platform === 'darwin' && files.filter(path => path.endsWith('.zip')).length !== 1)
    || files.filter(path => path.endsWith('.yml')).length !== 1) {
    throw new Error('安装包、更新包或更新元数据缺失/重复');
  }
  return files;
}

export function refreshUpdateMetadata(artifacts) {
  const byName = new Map(artifacts.map(path => [basename(path), path]));
  for (const path of artifacts.filter(file => file.endsWith('.yml'))) {
    const info = parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(info?.files) || info.files.length === 0) throw new Error('更新文件列表为空');
    const checksum = name => {
      const file = byName.get(name);
      if (!file || file === path || name.endsWith('.yml')) throw new Error('更新元数据引用了本次构建之外的文件');
      return { sha512: createHash('sha512').update(readFileSync(file)).digest('base64'), size: statSync(file).size };
    };
    for (const entry of info.files) Object.assign(entry, checksum(entry.url));
    if (info.path) info.sha512 = checksum(info.path).sha512;
    writeFileSync(path, stringify(info));
  }
}
