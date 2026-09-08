import { existsSync } from 'node:fs';
import { shell } from 'electron';
import type { DesktopHostResult } from '../shared/types.js';

export async function openExternal(
  url: string,
  options: {
    allowInsecureHttp?: boolean;
    opener?(url: string): Promise<void>;
  } = {}
): Promise<void> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:'
    && !(options.allowInsecureHttp === true && parsed.protocol === 'http:')
  ) {
    throw new Error('Only HTTPS links are allowed');
  }
  await (options.opener ?? shell.openExternal)(parsed.toString());
}

export async function revealPath(path: string): Promise<DesktopHostResult> {
  if (!existsSync(path)) {
    return { ok: false, code: 'FAILED', message: '路径不存在' };
  }
  shell.showItemInFolder(path);
  return { ok: true };
}
