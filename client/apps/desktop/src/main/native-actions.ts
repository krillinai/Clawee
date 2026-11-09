import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
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

const DOCUMENT_EXTENSIONS = new Set([
  '.csv', '.doc', '.docx', '.html', '.htm', '.md', '.markdown', '.pdf', '.ppt', '.pptx', '.xls', '.xlsx'
]);

export async function openFile(path: string): Promise<DesktopHostResult> {
  if (!isAbsolute(path) || path.includes('\0')) {
    return { ok: false, code: 'FAILED', message: '文件路径无效' };
  }
  let target: string;
  try {
    target = realpathSync(path);
    if (!statSync(target).isFile() || !DOCUMENT_EXTENSIONS.has(extname(target).toLowerCase())) {
      return { ok: false, code: 'FAILED', message: '仅支持使用默认应用打开文档' };
    }
  } catch {
    return { ok: false, code: 'FAILED', message: '文件不存在或无法访问' };
  }
  try {
    const error = await shell.openPath(target);
    if (!error) return { ok: true };
  } catch {
    // 系统异常与无关联应用统一显示可操作的错误。
  }
  return { ok: false, code: 'FAILED', message: '无法使用默认应用打开，请检查文件关联和访问权限' };
}
