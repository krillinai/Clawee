import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.CI !== 'true' || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) {
  throw new Error('安装验收仅在隔离 CI runner 执行');
}
const manifest = JSON.parse(readFileSync(process.env.CLAWEE_DESKTOP_BUILD_MANIFEST, 'utf8'));
const root = mkdtempSync(join(process.env.RUNNER_TEMP, 'customer-install-'));
const artifacts = manifest.artifacts.filter((item) => item.path.endsWith(process.platform === 'darwin' ? '.dmg' : '.exe'));
if (artifacts.length !== 1) throw new Error('安装包数量不正确');
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 300_000 });
  if (result.status !== 0) throw new Error('安装包安装验收失败');
};
let packageRoot;
if (process.platform === 'darwin') {
  const mount = join(root, 'volume');
  mkdirSync(mount);
  run('hdiutil', ['attach', artifacts[0].path, '-readonly', '-nobrowse', '-mountpoint', mount]);
  try {
    packageRoot = join(root, 'Clawee.app');
    cpSync(join(mount, 'Clawee.app'), packageRoot, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  } finally {
    run('hdiutil', ['detach', mount]);
  }
  run('codesign', ['--verify', '--deep', '--strict', packageRoot]);
  run('xcrun', ['stapler', 'validate', packageRoot]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', packageRoot]);
} else if (process.platform === 'win32') {
  packageRoot = join(root, 'installed');
  if (/\s/.test(packageRoot)) throw new Error('NSIS 验收临时路径不能包含空白');
  run(artifacts[0].path, ['/S', `/D=${packageRoot}`]);
  if (!existsSync(join(packageRoot, 'Clawee.exe'))) throw new Error('NSIS 未生成已安装客户端');
} else {
  throw new Error('不支持的安装验收平台');
}
const installedManifest = join(root, 'installed-build-manifest.json');
writeFileSync(installedManifest, JSON.stringify({ ...manifest, packageRoot }, null, 2));
appendFileSync(process.env.GITHUB_ENV, `CUSTOMER_INSTALLED_BUILD_MANIFEST=${installedManifest}\n`);
