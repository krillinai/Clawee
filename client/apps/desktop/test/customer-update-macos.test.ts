import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerUpdateRelease } from '../src/main/customer-update.js';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), removeDirectory: vi.fn(), downloadedFile: '', metadata: {} }));
const roots: string[] = [];

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.execute }) };
});

vi.mock('original-fs', () => ({ promises: { rm: mocks.removeDirectory } }));
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  access: vi.fn(async () => {}), statfs: vi.fn(async () => ({ bavail: 100_000_000, bsize: 4096 }))
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/Applications/Clawee.app/Contents/MacOS/Clawee' },
  autoUpdater: {}
}));

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  class MacUpdater extends EventEmitter {
    async downloadUpdate() {
      this.emit('update-downloaded', { ...mocks.metadata, downloadedFile: mocks.downloadedFile });
    }
  }
  return { default: { MacUpdater } };
});

import { createCustomerNativeUpdater } from '../src/main/customer-update-native.js';

beforeEach(async () => {
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  mocks.removeDirectory.mockReset().mockImplementation(original.rm);
  mocks.execute.mockReset();
  mocks.execute.mockImplementation(async (command: string, args: string[]) => {
    if (command === '/usr/bin/ditto') {
      const directory = args[3]!;
      roots.push(directory);
      await mkdir(join(directory, 'Clawee.app/Contents/Resources'), { recursive: true });
    }
    return {
      stdout: command === '/usr/bin/plutil'
        ? args[1] === 'CFBundleIdentifier' ? 'work.clawee.desktop' : '0.1.9'
        : '',
      stderr: 'TeamIdentifier=CLAWEETEAM'
    };
  });
});

afterEach(() => {
  mocks.removeDirectory.mockReset();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function macUpdateFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-macos-update-test-'));
  roots.push(directory);
  const path = join(directory, 'Clawee.zip');
  const bytes = Buffer.from('macOS 更新校验边界 fixture');
  writeFileSync(path, bytes);
  const artifact = {
    platform: 'macos' as const, arch: 'arm64' as const, url: 'https://files.example/Clawee.zip',
    sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length
  };
  const release: CustomerUpdateRelease = {
    kind: 'customer-desktop-update', gateway_url: 'https://customer.example.com',
    version: '0.1.9', notes: '', revision: 7, published_at: '2026-10-12T00:00:00Z',
    packages: [artifact]
  };
  mocks.downloadedFile = path;
  mocks.metadata = {
    version: release.version, releaseNotes: release.notes,
    files: [{ url: artifact.url, sha512: artifact.sha512, size: artifact.size }]
  };
  return { adapter: createCustomerNativeUpdater('darwin')!, artifact, release };
}

describe('macOS 更新校验临时目录清理（原生命令边界 fake）', () => {
  it('清理使用有界重试，校验成功后才能完成下载', async () => {
    const { adapter, release, artifact } = macUpdateFixture();
    await expect(adapter.download(release, artifact)).resolves.toBeUndefined();
    expect(mocks.removeDirectory).toHaveBeenCalledWith(expect.stringContaining('clawee-update-verify-'), {
      recursive: true, force: true, maxRetries: 5, retryDelay: 200
    });
    expect(mocks.execute).toHaveBeenCalledWith('/usr/bin/codesign',
      ['--verify', '--deep', '--strict', expect.stringContaining('clawee-update-verify-')],
      { timeout: 120_000 });
  });

  it('清理重试耗尽不使已通过校验的下载失败，再次校验仍能通过', async () => {
    const error = Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
    mocks.removeDirectory.mockRejectedValue(error);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { adapter, release, artifact } = macUpdateFixture();
    await expect(adapter.download(release, artifact)).resolves.toBeUndefined();
    await expect(adapter.verify(artifact)).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('更新校验临时目录清理失败', error);
  });

  it.each(['签名', '身份', '版本', '解压'])('%s失败仍拒绝更新，清理异常不覆盖原始错误', async failure => {
    mocks.removeDirectory.mockRejectedValue(Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const execute = mocks.execute.getMockImplementation()!;
    mocks.execute.mockImplementation(async (command: string, args: string[]) => {
      const updated = args.some(value => value.includes('clawee-update-verify-'));
      if (updated && failure === '签名' && command === '/usr/bin/codesign') throw new Error('签名无效');
      if (failure === '解压' && command === '/usr/bin/ditto') {
        roots.push(args[3]!);
        throw new Error('解压失败');
      }
      if (updated && command === '/usr/bin/plutil'
        && (failure === '身份' && args[1] === 'CFBundleIdentifier'
          || failure === '版本' && args[1] === 'CFBundleShortVersionString')) {
        return { stdout: 'mismatch', stderr: '' };
      }
      return execute(command, args);
    });
    const { adapter, release, artifact } = macUpdateFixture();
    await expect(adapter.download(release, artifact)).rejects.toThrow('更新包签名、产品身份或解压检查失败');
    expect(mocks.removeDirectory).toHaveBeenCalledOnce();
  });
});
