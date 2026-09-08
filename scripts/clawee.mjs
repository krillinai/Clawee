import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
function canonicalPath(input) {
  if (existsSync(input)) return realpathSync(input);
  return resolve(canonicalPath(dirname(input)), basename(input));
}
function assertExternal(input) {
  const location = relative(realpathSync(root), canonicalPath(input));
  if (!location || (location !== '..' && !location.startsWith('..' + sep) && !isAbsolute(location))) {
    throw new Error('运维配置目录必须位于源码仓库之外');
  }
}
function run(program, argv, directory) {
  const shims = mkdtempSync(resolve(tmpdir(), 'clawee-corepack-'));
  let result;
  try {
    const enabled = spawnSync('corepack', ['enable', '--install-directory', shims, 'pnpm'], { stdio: 'inherit' });
    if (enabled.error) throw enabled.error;
    if (enabled.status !== 0) throw new Error('无法准备 Corepack pnpm 入口');
    // 子脚本中的 pnpm 也必须遵守当前组件的 packageManager，不能落到全局版本。
    result = spawnSync(program, argv, {
      cwd: resolve(root, directory), stdio: 'inherit',
      env: { ...process.env, PATH: shims + delimiter + (process.env.PATH ?? '') }
    });
  } finally {
    rmSync(shims, { recursive: true, force: true });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (command === 'setup') {
  run('corepack', ['pnpm', 'install', '--frozen-lockfile'], 'client');
  run('corepack', ['pnpm', 'install', '--frozen-lockfile'], 'server/web');
} else if (command === 'client' || command === 'admin') {
  run('corepack', ['pnpm', ...args], command === 'client' ? 'client' : 'server/web');
} else if (command === 'server') {
  run('make', args, 'server');
} else if (command === 'init') {
  const index = args.indexOf('--ops-dir');
  const input = index >= 0 ? args[index + 1] : process.env.CLAWEE_OPS_DIR;
  if (!input) throw new Error('请通过 --ops-dir 或 CLAWEE_OPS_DIR 指定仓库外的配置目录');
  const opsDir = resolve(input);
  assertExternal(opsDir);
  const gatewayIndex = args.indexOf('--gateway');
  const gateway = new URL(gatewayIndex >= 0 ? args[gatewayIndex + 1] : 'http://127.0.0.1:1904');
  if (!['https:', 'http:'].includes(gateway.protocol) || gateway.username || gateway.password || gateway.pathname !== '/' || gateway.search || gateway.hash) {
    throw new Error('Gateway 必须是无路径、凭据或查询参数的 HTTP(S) Origin');
  }
  const require = createRequire(resolve(root, 'client/apps/daemon/package.json'));
  const yaml = require('yaml');
  const config = yaml.parse(readFileSync(resolve(root, 'server/configs/config.example.yaml'), 'utf8'));
  const directory = resolve(opsDir, 'configs');
  assertExternal(directory);
  assertExternal(resolve(directory, 'config.yaml'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configPath = resolve(directory, 'config.yaml');
  if (existsSync(configPath)) {
    console.log(`已有配置，未覆盖：${configPath}`);
  } else {
    const container = args.includes('--container');
    config.server.addr = container ? '0.0.0.0:1904' : '127.0.0.1:1904';
    if (container) {
      const password = randomBytes(32).toString('hex');
      config.database.url = `postgres://claw_mcp:${password}@postgres:5432/claw_mcp?sslmode=disable`;
      writeFileSync(resolve(opsDir, '.env'), `POSTGRES_PASSWORD=${password}\n`, { mode: 0o600, flag: 'wx' });
    }
    config.security.user_jwt_signing_key = randomBytes(32).toString('hex');
    config.security.agent_token_encryption_key = randomBytes(16).toString('hex');
    config.security.session_cookie_secure = gateway.protocol === 'https:';
    config.model_access.mode = 'enterprise_managed';
    config.mcp.public_base_url = gateway.origin;
    config.mcp.auth.resource = `${gateway.origin}/mcp`;
    config.mcp.auth.resource_metadata_url = `${gateway.origin}/.well-known/oauth-protected-resource/mcp`;
    config.mcp.auth.authorization_servers = [];
    config.office.install.public_base_url = gateway.origin;
    config.skillhub.enabled = true;
    config.skillhub.package_root = resolve(opsDir, 'data/skillhub/packages');
    config.skillhub.repository_root = resolve(opsDir, 'data/skillhub/repositories');
    config.shared_files.storage_root = resolve(opsDir, 'data/shared-files');
    if (container) {
      config.skillhub.package_root = '/app/data/skillhub/packages';
      config.skillhub.repository_root = '/app/data/skillhub/repositories';
      config.shared_files.storage_root = '/app/data/shared-files';
    }
    writeFileSync(configPath, yaml.stringify(config), { mode: 0o600, flag: 'wx' });
    console.log(`已生成配置：${configPath}`);
  }
  console.log('启动服务端前设置 CLAWEE_OPS_DIR 为上述运维目录。');
} else {
  console.error('用法：node scripts/clawee.mjs setup | init --ops-dir <目录> | client <命令> | admin <命令> | server <make目标>');
  process.exitCode = 1;
}
