import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCustomerUpdateMarker, assertUpdateRuntimeDependencies, emitCustomerUpdateManifest, stageCustomerUpdateMarker } from '../scripts/customer-update-contract.mjs';

const roots = [];
const requireFrom = createRequire(import.meta.url);
const gateway = 'https://customer.example.com';
function root() {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-update-contract-'));
  roots.push(directory);
  return directory;
}
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('客户更新打包契约', () => {
  it('只给显式HTTPS非官方客户构建写标记，旧HTTP与通用构建清除旧标记', () => {
    const directory = root();
    const path = join(directory, 'customer-update.json');
    expect(stageCustomerUpdateMarker({ directory, gateway, overridePath: '/ops/customer.toml', officialRelease: false })).toBe(gateway);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ gateway_url: gateway });
    for (const overrides of [{ overridePath: undefined }, { officialRelease: true }, { gateway: 'http://127.0.0.1:1904' }, { gateway: 'https://localhost' }]) {
      writeFileSync(path, 'stale');
      expect(stageCustomerUpdateMarker({ directory, gateway, overridePath: '/ops/customer.toml', officialRelease: false, ...overrides })).toBeUndefined();
      expect(existsSync(path)).toBe(false);
    }
  });

  it.each([
    { platform: 'darwin', arch: 'arm64', artifact: 'Clawee-0.1.9-arm64.zip', outputPlatform: 'macos' },
    { platform: 'darwin', arch: 'x64', artifact: 'Clawee-0.1.9.zip', outputPlatform: 'macos' },
    { platform: 'win32', arch: 'x64', artifact: 'Clawee-Setup-0.1.9.exe', outputPlatform: 'windows' }
  ])('从实际本平台artifact生成设计schema及真实sha512/size：$platform/$arch', async target => {
    const directory = root();
    const path = join(directory, target.artifact);
    const bytes = Buffer.from('已生成的安装包字节');
    writeFileSync(path, bytes);
    const result = await emitCustomerUpdateManifest({ directory, gateway, version: '0.1.9', notes: '客户说明', platform: target.platform, arch: target.arch, artifacts: [path], downloadBase: 'https://files.customer.example/packages/' });
    expect(result.template).toBe(false);
    expect(JSON.parse(readFileSync(result.path, 'utf8'))).toEqual({
      kind: 'customer-desktop-update', gateway_url: gateway, version: '0.1.9', notes: '客户说明',
      packages: [{ platform: target.outputPlatform, arch: target.arch, url: `https://files.customer.example/packages/0.1.9/${target.outputPlatform}/${target.arch}/${target.artifact}`, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length }]
    });
  });

  it.each(['9007199254740992.0.0', '1.9007199254740992.0', '1.2.9007199254740992', '99999999999999999999.0.0'])('版本分量超出安全整数时不生成清单：%s', async version => {
    const directory = root();
    const artifact = join(directory, 'Clawee-arm64.zip');
    writeFileSync(artifact, 'zip');
    await expect(emitCustomerUpdateManifest({ directory, gateway, version, platform: 'darwin', arch: 'arm64', artifacts: [artifact], downloadBase: 'https://files.customer.example/packages' })).rejects.toThrow();
    expect(existsSync(join(directory, 'customer-update-manifest.json'))).toBe(false);
  });

  it.each(['0.0.0', '9007199254740991.0.0', '1.9007199254740991.0', '1.2.9007199254740991', '9007199254740991.9007199254740991.9007199254740991'])('安全整数边界版本可生成清单：%s', async version => {
    const directory = root();
    const artifact = join(directory, 'Clawee-arm64.zip');
    writeFileSync(artifact, 'zip');
    const result = await emitCustomerUpdateManifest({ directory, gateway, version, platform: 'darwin', arch: 'arm64', artifacts: [artifact], downloadBase: 'https://files.customer.example/packages' });
    expect(JSON.parse(readFileSync(result.path, 'utf8')).version).toBe(version);
  });

  it('没有下载base仅生成明显不可发布的待补URL模板，不复用旧清单/官方地址', async () => {
    const directory = root();
    const artifact = join(directory, 'Clawee-arm64.zip');
    writeFileSync(artifact, 'zip');
    writeFileSync(join(directory, 'customer-update-manifest.json'), 'stale');
    const result = await emitCustomerUpdateManifest({ directory, gateway, version: '0.1.9', platform: 'darwin', arch: 'arm64', artifacts: [artifact] });
    expect(result).toEqual({ path: join(directory, 'customer-update-manifest.template.json'), template: true });
    expect(existsSync(join(directory, 'customer-update-manifest.json'))).toBe(false);
    expect(JSON.parse(readFileSync(result.path, 'utf8')).packages[0].url).toContain('__待填写客户HTTPS下载地址__');
    const generic = await emitCustomerUpdateManifest({ directory, gateway: undefined });
    expect(generic).toBeUndefined();
    expect(existsSync(result.path)).toBe(false);
  });

  it.each(['http://files.example/packages', 'https://user:password@files.example/packages', 'https://official.example/clawee', 'https://official.example/clawee/updates/stable'])('不安全base与官方COS目录阻止生成可发布清单：%s', async downloadBase => {
    const directory = root();
    const artifact = join(directory, 'Clawee-arm64.zip');
    writeFileSync(artifact, 'zip');
    await expect(emitCustomerUpdateManifest({ directory, gateway, version: '0.1.9', platform: 'darwin', arch: 'arm64', artifacts: [artifact], downloadBase, officialBase: 'https://official.example', officialPrefix: 'clawee' })).rejects.toThrow();
    expect(existsSync(join(directory, 'customer-update-manifest.json'))).toBe(false);
  });

  it('无本次ZIP、重复ZIP以及非支持平台不伪造包', async () => {
    for (const value of [{ artifacts: [] }, { artifacts: ['one.zip', 'two.zip'] }, { platform: 'linux', artifacts: [] }, { platform: 'win32', arch: 'arm64', artifacts: [] }]) {
      await expect(emitCustomerUpdateManifest({ directory: root(), gateway, version: '0.1.9', platform: 'darwin', arch: 'arm64', ...value })).rejects.toThrow();
    }
  });

  it('verify-package区分客户、通用和官方标记', () => {
    const resources = root();
    const deployment = join(resources, 'deployment');
    mkdirSync(deployment);
    stageCustomerUpdateMarker({ directory: deployment, gateway, overridePath: '/ops/customer.toml', officialRelease: false });
    expect(() => assertCustomerUpdateMarker(resources, { customerUpdateGateway: gateway, enterpriseOrigin: gateway, officialRelease: false })).not.toThrow();
    expect(() => assertCustomerUpdateMarker(resources, {})).toThrow('通用');
    expect(() => assertCustomerUpdateMarker(resources, { customerUpdateGateway: gateway, enterpriseOrigin: gateway, officialRelease: true })).toThrow('渠道');
    expect(() => assertCustomerUpdateMarker(resources, { customerUpdateGateway: gateway, enterpriseOrigin: 'https://other.example' })).toThrow('渠道');
  });

  it('实际materialized生产依赖可加载，缺失传递依赖绝不借用开发目录', () => {
    const resources = root();
    const target = join(resources, 'node_modules');
    mkdirSync(target);
    const copied = new Set();
    const copy = (name, parentRequire) => {
      const metadataPath = parentRequire.resolve(`${name}/package.json`);
      if (copied.has(name)) return;
      copied.add(name);
      const destination = join(target, name);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(dirname(metadataPath), destination, { dereference: true, recursive: true });
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      const dependencyRequire = createRequire(metadataPath);
      for (const dependency of Object.keys(metadata.dependencies ?? {})) copy(dependency, dependencyRequire);
    };
    copy('electron-updater', requireFrom);
    copy('js-yaml', requireFrom);
    expect(() => assertUpdateRuntimeDependencies(resources)).not.toThrow();
    rmSync(join(target, 'tiny-typed-emitter'), { recursive: true });
    expect(() => assertUpdateRuntimeDependencies(resources)).toThrow();
  });

  it('生产依赖与package入口固定，builder保持26且verify检查真实依赖', () => {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(metadata.dependencies['electron-updater']).toBe('6.8.10');
    expect(metadata.devDependencies['electron-builder']).toBe('^26.15.3');
    const packageScript = readFileSync('scripts/package-release.mjs', 'utf8');
    const verifier = readFileSync('scripts/verify-package.mjs', 'utf8');
    expect(packageScript).toContain('CLAWEE_DESKTOP_GATEWAY_CONFIG_PATH');
    expect(packageScript).toContain('CLAWEE_CUSTOMER_UPDATE_DOWNLOAD_BASE');
    expect(packageScript).toContain('assertUpdateRuntimeDependencies(desktopRuntimeStage)');
    expect(verifier).toContain('assertUpdateRuntimeDependencies(resourcesDir)');
    expect(verifier).toContain('assertCustomerUpdateMarker(resourcesDir, manifest)');
  });
});
