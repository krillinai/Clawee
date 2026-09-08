import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, 'third_party/generated'));
mkdirSync(output, { recursive: true });
function run(command, args, cwd, input, env = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', input, env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} 执行失败：${result.stderr}`);
  return result.stdout;
}
function licenseFiles(directory) {
  if (!directory || !existsSync(directory)) return [];
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!/^(licen[cs]e|copying|notice|copyright)/i.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isFile() && statSync(path).size < 4 * 1024 * 1024) {
      result.push({ name: entry.name, text: readFileSync(path, 'utf8') });
    }
  }
  return result;
}
function npmLicenseFiles(entry, version) {
  const directory = entry.paths.find(path => existsSync(join(path, 'package.json')) && JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version === version);
  const files = licenseFiles(directory);
  if (files.length) return files;
  const upstream = join(root, 'third_party/npm-licenses', encodeURIComponent(`${entry.name}@${version}`));
  const saved = licenseFiles(upstream);
  if (saved.length) return saved;
  if (directory) {
    for (const name of readdirSync(directory).filter(name => /^readme(\.|$)/i.test(name))) {
      const text = readFileSync(join(directory, name), 'utf8');
      if (/permission is hereby granted|redistribution and use in source and binary forms/i.test(text)) return [{ name, text }];
    }
  }
  return [];
}
function save(group, entries) {
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const notices = ['第三方许可原文；由 scripts/license-inventory.mjs 生成。\n'];
  const unresolved = [];
  const components = entries.map(entry => {
    if (!entry.files.length) unresolved.push(`${entry.name}@${entry.version}`);
    notices.push(`\n===== ${entry.name}@${entry.version} (${entry.license ?? '见随附原文'}) =====\n`);
    for (const file of entry.files) notices.push(`\n--- ${file.name} ---\n${file.text}\n`);
    const component = {
      type: 'library', name: entry.name, version: entry.version,
      purl: entry.purl, 'bom-ref': entry.purl,
      properties: [{ name: 'clawee:license-texts', value: entry.files.map(file => file.name).join(',') }]
    };
    if (entry.license && entry.license !== 'UNKNOWN') component.licenses = [{ expression: entry.license }];
    return component;
  });
  writeFileSync(join(output, `${group}-NOTICES.txt`), notices.join(''));
  writeFileSync(join(output, `${group}.cdx.json`), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, components }, null, 2) + '\n');
  console.log(`${group}: ${entries.length} 个组件，${unresolved.length} 个未找到顶层许可文本`);
  return unresolved;
}
const review = {};
for (const [group, directory] of [['client', 'client'], ['admin', 'server/web']]) {
  const licenses = JSON.parse(run('corepack', ['pnpm', 'licenses', 'list', '--json'], join(root, directory)));
  review[group] = save(group, Object.values(licenses).flat().flatMap(entry => entry.versions.map(version => ({
    name: entry.name, version, license: entry.license,
    purl: `pkg:npm/${entry.name.replace('@', '%40')}@${version}`,
    files: npmLicenseFiles(entry, version)
  }))));
}
const goTargets = ['linux/amd64', 'linux/arm64', 'darwin/amd64', 'darwin/arm64', 'windows/amd64', 'windows/arm64'];
const moduleStream = goTargets.map(target => {
  const [GOOS, GOARCH] = target.split('/');
  return run('go', ['list', '-deps', '-json', './cmd/...'], join(root, 'server'), undefined, { CGO_ENABLED: '0', GOOS, GOARCH });
}).join('\n');
const modules = JSON.parse(run('jq', ['-s', '[.[].Module | select(. != null)] | unique_by(.Path)'], root, moduleStream));
review.go = save('go', modules.filter(module => !module.Main).map(module => ({
  name: module.Path, version: module.Version, purl: `pkg:golang/${module.Path}@${module.Version}`,
  files: licenseFiles(module.Dir)
})));
review.goTargets = goTargets;
const goRoot = run('go', ['env', 'GOROOT'], root).trim();
const goRuntimeLicenses = licenseFiles(goRoot);
if (!goRuntimeLicenses.length) throw new Error('缺少 Go 标准库许可');
writeFileSync(join(output, 'go-runtime-NOTICES.txt'), [
  'Go 标准库许可；实际编译器版本以可执行文件构建信息为准。\n',
  ...goRuntimeLicenses.map(file => `\n--- ${file.name} ---\n${file.text}\n`)
].join(''));
review.inputs = Object.fromEntries(['client/pnpm-lock.yaml', 'server/web/pnpm-lock.yaml', 'server/go.sum'].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
writeFileSync(join(output, 'review.json'), JSON.stringify(review, null, 2) + '\n');
