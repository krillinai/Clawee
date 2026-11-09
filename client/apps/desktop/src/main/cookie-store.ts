import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function prepareUnencryptedCookieStore(sessionData: string): void {
  const marker = join(sessionData, '.cookie-store-unencrypted-v1');
  if (existsSync(marker)) return;

  // 关闭 Cookie 加密后旧库不可读，须在 Electron 创建会话前清理一次。
  for (const directory of [sessionData, join(sessionData, 'Network')]) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      rmSync(join(directory, `Cookies${suffix}`), { force: true });
    }
  }
  mkdirSync(sessionData, { recursive: true });
  writeFileSync(marker, 'unencrypted\n', { mode: 0o600 });
}
