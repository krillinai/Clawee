import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, readCustomer, readUpstream, root } from './customer-config.mjs';

export function fileRecord(path) {
  return { name: basename(path), bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

export function verifyFiles(directory, files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('交付文件为空');
  const names = new Set();
  for (const file of files) {
    if (typeof file.name !== 'string' || file.name !== basename(file.name) || /[\\/\r\n]/.test(file.name) || names.has(file.name)) throw new Error('交付文件名无效或重复');
    names.add(file.name);
    const actual = fileRecord(join(directory, file.name));
    if (file.bytes !== actual.bytes || file.sha256 !== actual.sha256) throw new Error(`交付文件校验失败: ${file.name}`);
  }
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: join(root, 'client'), env, encoding: 'utf8', timeout: 300_000 });
  if (result.status !== 0) throw new Error(`交付验证失败: ${command}\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function buildDelivery(id, manifestPath, output) {
  const customer = readCustomer(id);
  const upstream = readUpstream();
  const sha = git(['rev-parse', 'HEAD']);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const version = JSON.parse(readFileSync(join(root, 'client/apps/desktop/package.json'), 'utf8')).version;
  if (git(['status', '--porcelain', '--untracked-files=all']) || manifest.dirty || manifest.commit !== sha ||
    process.env.CLAWEE_OFFICIAL_RELEASE !== '0' || manifest.officialRelease !== false ||
    manifest.enterpriseGatewayConfigHash !== customer.configSha256 || manifest.enterpriseOrigin !== customer.gateway || manifest.releaseVersion !== version) {
    throw new Error('构建清单与干净客户提交不一致，或官方更新未禁用');
  }
  const platform = manifest.platform === 'darwin' ? 'macos' : 'windows';
  const key = `${manifest.platform}/${manifest.arch}`;
  if (!['darwin/arm64', 'darwin/x64', 'win32/x64'].includes(key) ||
    (platform === 'macos' ? manifest.mode !== 'release' : manifest.mode !== 'dist')) throw new Error('构建平台或签名模式不符合首期交付要求');
  run(process.execPath, [join(root, 'client/apps/desktop/scripts/verify-package.mjs')], {
    ...process.env,
    CLAWEE_DESKTOP_BUILD_MANIFEST: resolve(manifestPath),
    CLAWEE_DESKTOP_PACKAGE_ROOT: manifest.packageRoot,
    ...(platform === 'macos' ? { CLAWEE_REQUIRE_DISTRIBUTABLE_MAC: '1' } : {})
  });
  const resources = platform === 'macos' ? join(manifest.packageRoot, 'Contents/Resources') : join(manifest.packageRoot, 'resources');
  if (readFileSync(join(resources, 'deployment/config.toml'), 'utf8') !== customer.contents || existsSync(join(resources, 'deployment/official-release.json'))) throw new Error('包内客户配置或更新标记不一致');
  const installers = manifest.artifacts.filter((file) => platform === 'macos' ? /\.(dmg|zip)$/.test(file.path) : /\.exe$/.test(file.path));
  if (platform === 'macos' ? !installers.some((file) => file.path.endsWith('.dmg')) || !installers.some((file) => file.path.endsWith('.zip')) : installers.length !== 1) throw new Error('安装包不完整');
  for (const artifact of installers) {
    const actual = fileRecord(artifact.path);
    if (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes) throw new Error('安装包已变更');
    if (platform === 'windows') {
      const status = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AuthenticodeSignature -LiteralPath $env.CUSTOMER_INSTALLER).Status.ToString()'], { ...process.env, CUSTOMER_INSTALLER: artifact.path });
      if (status !== 'NotSigned') throw new Error('Windows 签名状态与首期未签名声明不一致');
    }
  }
  const directory = join(output, id, version, sha, platform, manifest.arch);
  if (existsSync(directory)) throw new Error('交付目录已存在，禁止覆盖');
  mkdirSync(directory, { recursive: true });
  for (const source of [...installers.map((item) => item.path), manifestPath]) copyFileSync(source, join(directory, basename(source)));
  const files = [...installers.map((item) => fileRecord(item.path)), fileRecord(manifestPath)];
  const runId = process.env.GITHUB_RUN_ID;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!runId || !repository) throw new Error('正式交付需要 workflow run 标识');
  const delivery = {
    schemaVersion: 1, customer: id, upstream, privateSha: sha, version,
    configSha256: customer.configSha256,
    workflowRun: `https://github.com/${repository}/actions/runs/${runId}`,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT,
    platform, arch: manifest.arch, signature: platform === 'macos' ? 'signed_notarized' : 'unsigned',
    buildManifest: basename(manifestPath), files
  };
  const deliveryPath = join(directory, 'customer-delivery.json');
  writeFileSync(deliveryPath, `${JSON.stringify(delivery, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(directory, 'SHA256SUMS'), [...files, fileRecord(deliveryPath)].map((file) => `${file.sha256}  ${file.name}\n`).join(''), { flag: 'wx' });
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `CUSTOMER_DELIVERY_ROOT=${resolve(output)}\n`);
  console.log(directory);
}

export function collectDeliveries(id, output) {
  const customer = readCustomer(id);
  const upstream = readUpstream();
  const sha = git(['rev-parse', 'HEAD']);
  const version = JSON.parse(readFileSync(join(root, 'client/apps/desktop/package.json'), 'utf8')).version;
  const deliveryRoot = join(output, id, version, sha);
  const deliveries = [];
  for (const [platform, arch] of [['macos', 'arm64'], ['macos', 'x64'], ['windows', 'x64']]) {
    const directory = join(deliveryRoot, platform, arch);
    const delivery = JSON.parse(readFileSync(join(directory, 'customer-delivery.json'), 'utf8'));
    if (delivery.customer !== customer.customer || delivery.privateSha !== sha || delivery.configSha256 !== customer.configSha256 ||
      delivery.upstream.sha !== upstream.sha || delivery.upstream.repository !== upstream.repository || delivery.version !== version ||
      delivery.platform !== platform || delivery.arch !== arch || delivery.signature !== (platform === 'macos' ? 'signed_notarized' : 'unsigned') ||
      delivery.workflowRun !== `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`) throw new Error('平台交付清单不一致');
    verifyFiles(directory, delivery.files);
    if (!delivery.files.some((file) => file.name === delivery.buildManifest)) throw new Error('缺少原始构建清单');
    const checksums = [...delivery.files, fileRecord(join(directory, 'customer-delivery.json'))].map((file) => `${file.sha256}  ${file.name}\n`).join('');
    if (readFileSync(join(directory, 'SHA256SUMS'), 'utf8') !== checksums) throw new Error('SHA256SUMS 与交付文件不一致');
    deliveries.push(delivery);
  }
  writeFileSync(join(deliveryRoot, 'customer-delivery.json'), `${JSON.stringify({ schemaVersion: 1, status: 'verified', customer: id, privateSha: sha, upstream, version, configSha256: customer.configSha256, platforms: deliveries }, null, 2)}\n`, { flag: 'wx' });
  console.log(`三平台交付文件校验通过: ${deliveryRoot}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, id, path, output] = process.argv.slice(2);
  if (command === 'build' && path && output) buildDelivery(id, path, resolve(output));
  else if (command === 'collect' && path) collectDeliveries(id, resolve(path));
  else throw new Error('用法: customer-manifest.mjs build 客户ID 构建清单 输出目录 | collect 客户ID 输出目录');
}
