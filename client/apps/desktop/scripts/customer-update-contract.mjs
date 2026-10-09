import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, relative, resolve } from 'node:path';

export function stageCustomerUpdateMarker({ directory, gateway, overridePath, officialRelease }) {
  const path = join(directory, 'customer-update.json');
  rmSync(path, { force: true });
  if (officialRelease || !overridePath || !gateway.startsWith('https://')) return undefined;
  const url = new URL(gateway);
  if (gateway !== url.origin || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined;
  writeFileSync(path, `${JSON.stringify({ gateway_url: gateway })}\n`);
  return gateway;
}

export async function emitCustomerUpdateManifest({ directory, gateway, version, notes = '', platform, arch, artifacts, downloadBase, officialBase, officialPrefix }) {
  const livePath = join(directory, 'customer-update-manifest.json');
  const templatePath = join(directory, 'customer-update-manifest.template.json');
  rmSync(livePath, { force: true });
  rmSync(templatePath, { force: true });
  if (gateway === undefined) return undefined;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || !version.split('.').every(component => Number.isSafeInteger(Number(component)))) {
    throw new Error('客户更新清单只支持各分量不超过 9007199254740991 的稳定版本');
  }
  const targetPlatform = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : undefined;
  if (targetPlatform === undefined || !['arm64', 'x64'].includes(arch) || (targetPlatform === 'windows' && arch !== 'x64')) {
    throw new Error('客户更新清单不支持此平台/架构');
  }
  const extension = targetPlatform === 'macos' ? '.zip' : '.exe';
  const candidates = artifacts.filter(path => path.endsWith(extension));
  if (candidates.length !== 1) throw new Error('客户更新清单缺少唯一的本次构建更新包');
  const artifact = candidates[0];
  const filename = basename(artifact);
  const suffix = `${version}/${targetPlatform}/${arch}/${encodeURIComponent(filename)}`;
  let url = `__待填写客户HTTPS下载地址__/${suffix}`;
  const template = !downloadBase?.trim();
  if (!template) {
    const base = new URL(downloadBase.trim());
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
      throw new Error('CLAWEE_CUSTOMER_UPDATE_DOWNLOAD_BASE 必须是客户静态下载 HTTPS base');
    }
    const normalizedBase = base.href.replace(/\/$/, '');
    const officialRoot = officialBase && officialPrefix
      ? `${officialBase.replace(/\/$/, '')}/${officialPrefix.replace(/^\/+|\/+$/g, '')}` : undefined;
    if (officialRoot && (normalizedBase === officialRoot || normalizedBase.startsWith(`${officialRoot}/`))) {
      throw new Error('客户更新下载 base 不得使用官方 COS 目录');
    }
    url = `${normalizedBase}/${suffix}`;
  }
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(artifact)) digest.update(chunk);
  const manifest = {
    kind: 'customer-desktop-update', gateway_url: gateway, version, notes,
    packages: [{ platform: targetPlatform, arch, url, sha512: digest.digest('base64'), size: statSync(artifact).size }]
  };
  const path = template ? templatePath : livePath;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path, template };
}

export function assertCustomerUpdateMarker(resourcesDir, manifest) {
  const path = join(resourcesDir, 'deployment', 'customer-update.json');
  if (manifest.customerUpdateGateway === undefined) {
    if (existsSync(path)) throw new Error('通用/官方包不应携带客户更新标记');
    return;
  }
  const marker = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.officialRelease || Object.keys(marker).length !== 1
    || marker.gateway_url !== manifest.customerUpdateGateway
    || marker.gateway_url !== manifest.enterpriseOrigin
    || !marker.gateway_url.startsWith('https://')) {
    throw new Error('客户更新标记与本次构建渠道不一致');
  }
}

export function assertUpdateRuntimeDependencies(resourcesDir) {
  const nodeModules = realpathSync(resolve(resourcesDir, 'node_modules'));
  const packagedRequire = createRequire(join(resourcesDir, 'app.asar', 'package.json'));
  const visited = new Set();
  const checkDependency = (name, requireFrom) => {
    const metadataPath = realpathSync(requireFrom.resolve(`${name}/package.json`));
    if (relative(nodeModules, metadataPath).startsWith('..')) throw new Error(`更新生产依赖逃逸打包资源：${name}`);
    if (visited.has(metadataPath)) return;
    visited.add(metadataPath);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const dependencyRequire = createRequire(metadataPath);
    for (const dependency of Object.keys(metadata.dependencies ?? {})) checkDependency(dependency, dependencyRequire);
  };
  for (const name of ['electron-updater', 'js-yaml']) {
    checkDependency(name, packagedRequire);
    const entry = packagedRequire.resolve(name);
    const location = relative(nodeModules, realpathSync(entry));
    if (location.startsWith('..') || !existsSync(entry)) throw new Error(`更新生产依赖不在打包资源内：${name}`);
    const loaded = packagedRequire(name);
    if (name === 'electron-updater' && (typeof loaded.MacUpdater !== 'function' || typeof loaded.NsisUpdater !== 'function')) {
      throw new Error('打包更新生产依赖无法加载');
    }
  }
  const metadata = JSON.parse(readFileSync(join(nodeModules, 'electron-updater/package.json'), 'utf8'));
  if (metadata.version !== '6.8.10') throw new Error('打包更新运行时版本与锁定版本不符');
}
