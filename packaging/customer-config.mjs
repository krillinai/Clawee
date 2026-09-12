import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'client/apps/desktop/package.json'));
const { stringify } = require('@iarna/toml');

export function selectCustomer(customers, id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ||
    !customers || typeof customers !== 'object' || Array.isArray(customers) || !Object.hasOwn(customers, id)) {
    throw new Error('客户 ID 无效或不存在');
  }
  const item = customers[id];
  if (!item || typeof item !== 'object' || Array.isArray(item) ||
    Object.keys(item).length !== 1 || typeof item.gateway !== 'string' || item.gateway !== item.gateway.trim()) {
    throw new Error('客户配置只能包含 gateway');
  }
  let url;
  try { url = new URL(item.gateway); } catch { throw new Error('客户 Gateway 无效'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
    item.gateway.includes('?') || item.gateway.includes('#') || item.gateway.includes('\\') ||
    host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) ||
    host === '[::1]' || host === '[::]' || host === '0.0.0.0' || /^\[::ffff:7f[0-9a-f]{2}:/.test(host)) {
    throw new Error('客户 Gateway 必须是无凭据、无路径的非回环 HTTPS origin');
  }
  // 不接受 URL 解析器消除点路径、空凭据等输入后得到的 origin。
  if (item.gateway !== url.origin && item.gateway !== `${url.origin}/`) {
    throw new Error('客户 Gateway 必须使用规范 HTTPS origin');
  }
  const contents = stringify({ gateway: url.origin });
  return { customer: id, gateway: url.origin, contents, configSha256: createHash('sha256').update(contents).digest('hex') };
}

export function readCustomer(id) {
  return selectCustomer(JSON.parse(readFileSync(join(root, 'customers.json'), 'utf8')), id);
}

export function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Git 校验失败: ${args[0]}`);
  return result.stdout.trim();
}

export function readUpstream() {
  const upstream = JSON.parse(readFileSync(join(root, 'packaging/upstream.json'), 'utf8'));
  if (upstream.repository !== 'krillinai/Clawee' || !/^[a-f0-9]{40}$/.test(upstream.sha) || Object.keys(upstream).length !== 2) {
    throw new Error('公共基线记录无效');
  }
  git(['merge-base', '--is-ancestor', upstream.sha, 'HEAD']);
  return upstream;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, id] = process.argv.slice(2);
  if (!['validate', 'generate'].includes(command)) throw new Error('用法: node packaging/customer-config.mjs validate|generate 客户ID');
  const customer = readCustomer(id);
  const upstream = readUpstream();
  if (command === 'generate') {
    const temp = process.env.RUNNER_TEMP || tmpdir();
    if (!isAbsolute(temp)) throw new Error('临时目录必须是绝对路径');
    const path = join(mkdtempSync(join(temp, 'clawee-customer-')), 'config.toml');
    writeFileSync(path, customer.contents, { mode: 0o600, flag: 'wx' });
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `CLAWEE_DESKTOP_GATEWAY_CONFIG_PATH=${path}\n`);
    console.log(path);
  } else {
    const sha = git(['rev-parse', 'HEAD']);
    if (process.env.CUSTOMER_SHA && sha !== process.env.CUSTOMER_SHA) throw new Error('源码 SHA 与输入不一致');
    const version = JSON.parse(readFileSync(join(root, 'client/apps/desktop/package.json'), 'utf8')).version;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('客户端版本无效');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\ncustomer=${customer.customer}\nversion=${version}\n`);
    console.log(JSON.stringify({ customer: customer.customer, sha, upstream, version, configSha256: customer.configSha256 }));
  }
}
