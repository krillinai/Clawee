import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareUnencryptedCookieStore } from '../src/main/cookie-store.js';

const directories: string[] = [];

function createSessionData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-cookie-store-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Cookie 存储切换', () => {
  it('首次切换仅清理旧 Cookie 数据库，保留凭据、任务和界面数据', () => {
    const sessionData = createSessionData();
    const cookieFiles = ['', 'Network'].flatMap(directory => (
      ['', '-journal', '-wal', '-shm'].map(suffix => join(directory, `Cookies${suffix}`))
    ));
    const retainedFiles = [
      'daemon/private/credentials.json',
      'daemon/runtime.sqlite',
      'desktop-settings.json',
      'Local Storage/leveldb/CURRENT',
      'Local State'
    ];
    for (const path of [...cookieFiles, ...retainedFiles]) {
      const target = join(sessionData, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, path);
    }

    prepareUnencryptedCookieStore(sessionData);

    for (const path of cookieFiles) expect(existsSync(join(sessionData, path))).toBe(false);
    for (const path of retainedFiles) expect(readFileSync(join(sessionData, path), 'utf8')).toBe(path);
  });

  it('支持新安装，并在后续启动保留新生成的 Cookie', () => {
    const sessionData = join(createSessionData(), 'new-session');

    prepareUnencryptedCookieStore(sessionData);
    const cookiePath = join(sessionData, 'Cookies');
    writeFileSync(cookiePath, 'new-cookie-store');
    prepareUnencryptedCookieStore(sessionData);

    expect(readFileSync(cookiePath, 'utf8')).toBe('new-cookie-store');
  });

  it('清理失败时允许下次启动重试', () => {
    const sessionData = createSessionData();
    const cookiePath = join(sessionData, 'Cookies');
    mkdirSync(cookiePath);
    writeFileSync(join(cookiePath, 'blocked'), 'blocked');

    expect(() => prepareUnencryptedCookieStore(sessionData)).toThrow();
    rmSync(cookiePath, { recursive: true });
    writeFileSync(cookiePath, 'old-cookie-store');
    prepareUnencryptedCookieStore(sessionData);

    expect(existsSync(cookiePath)).toBe(false);
  });
});
