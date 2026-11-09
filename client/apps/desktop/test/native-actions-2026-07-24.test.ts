import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shellOpenExternal = vi.hoisted(() => vi.fn(async () => undefined));
const shellOpenPath = vi.hoisted(() => vi.fn(async (_path: string) => ''));

vi.mock('electron', () => ({
  shell: { openExternal: shellOpenExternal, openPath: shellOpenPath }
}));

import { openExternal, openFile } from '../src/main/native-actions.js';

describe('桌面默认应用打开', () => {
  let directory: string;
  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'clawee-open-file-')));
    shellOpenPath.mockReset().mockResolvedValue('');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('通过系统关联打开含中文、空格和单引号的原文档', async () => {
    const path = join(directory, "培训方案 O'Brien.pptx");
    writeFileSync(path, 'presentation');
    await expect(openFile(path)).resolves.toEqual({ ok: true });
    expect(shellOpenPath).toHaveBeenCalledExactlyOnceWith(path);
  });

  it('拒绝相对路径、网址、不存在的文件、目录和可执行文件', async () => {
    const executable = join(directory, 'report.exe');
    writeFileSync(executable, 'executable');
    for (const path of ['relative.pptx', 'https://example.com/report.pptx', join(directory, 'missing.pptx'), directory, executable]) {
      await expect(openFile(path)).resolves.toMatchObject({ ok: false, code: 'FAILED' });
    }
    expect(shellOpenPath).not.toHaveBeenCalled();
  });

  (process.platform === 'win32' ? it.skip : it)('拒绝伪装成文档的可执行文件链接', async () => {
    const executable = join(directory, 'report.sh');
    writeFileSync(executable, 'executable');
    const alias = join(directory, 'report.pdf');
    symlinkSync(executable, alias);
    await expect(openFile(alias)).resolves.toMatchObject({ ok: false });
    expect(shellOpenPath).not.toHaveBeenCalled();
  });

  it('系统未能打开文件时返回用户可读错误', async () => {
    const path = join(directory, 'report.pdf');
    writeFileSync(path, 'pdf');
    shellOpenPath.mockResolvedValueOnce('No application associated');
    await expect(openFile(path)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('默认应用') });
    shellOpenPath.mockRejectedValueOnce(new Error('OS failure'));
    await expect(openFile(path)).resolves.toMatchObject({ ok: false });
  });
});

describe('desktop external URL boundary', () => {
  beforeEach(() => {
    shellOpenExternal.mockClear();
  });

  it('allows HTTPS and rejects insecure or non-web protocols by default', async () => {
    await expect(openExternal('https://enterprise.example/login')).resolves.toBeUndefined();
    expect(shellOpenExternal).toHaveBeenCalledWith('https://enterprise.example/login');

    await expect(openExternal('http://enterprise.example/login')).rejects.toThrow(
      'Only HTTPS links are allowed'
    );
    await expect(openExternal('file:///tmp/login')).rejects.toThrow(
      'Only HTTPS links are allowed'
    );
  });

  it('allows HTTP only behind the explicit development or E2E gate', async () => {
    const opener = vi.fn(async () => undefined);

    await expect(openExternal('http://127.0.0.1:1904/login', {
      allowInsecureHttp: true,
      opener
    })).resolves.toBeUndefined();

    expect(opener).toHaveBeenCalledWith('http://127.0.0.1:1904/login');
    expect(shellOpenExternal).not.toHaveBeenCalled();
  });
});

describe('desktop project boundary', () => {
  it('keeps project creation in the Runtime instead of the native bridge', () => {
    const nativeActions = readFileSync('src/main/native-actions.ts', 'utf8');
    const main = readFileSync('src/main/desktop-main.ts', 'utf8');
    const ipc = readFileSync('src/shared/ipc.ts', 'utf8');
    const preload = readFileSync('src/preload/index.ts', 'utf8');

    expect(nativeActions).not.toContain('ensureDefaultProjectDirectory');
    expect(nativeActions).not.toContain('createNamedProjectDirectory');
    expect(main).not.toContain('desktopIpc.ensureDefaultProjectDirectory');
    expect(main).not.toContain('desktopIpc.createProjectDirectory');
    expect(ipc).not.toContain('ensureDefaultProjectDirectory');
    expect(ipc).not.toContain('createProjectDirectory');
    expect(preload).not.toContain('ensureDefaultProjectDirectory');
    expect(preload).not.toContain('createProjectDirectory');
  });

  it('passes the system documents directory to the Runtime managed project root', () => {
    const main = readFileSync('src/main/desktop-main.ts', 'utf8');
    const bootstrap = readFileSync('src/main/bootstrap-controller.ts', 'utf8');
    const daemonManager = readFileSync('src/main/daemon-manager.ts', 'utf8');

    expect(main).toContain("app.getPath('documents')");
    expect(bootstrap).toContain('defaultProjectRoot: this.input.defaultProjectRoot');
    expect(daemonManager).toContain(
      'CLAWEE_DEFAULT_PROJECT_ROOT: input.defaultProjectRoot'
    );
  });
});
