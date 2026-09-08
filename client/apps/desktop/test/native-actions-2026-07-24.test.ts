import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shellOpenExternal = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('electron', () => ({
  shell: { openExternal: shellOpenExternal }
}));

import { openExternal } from '../src/main/native-actions.js';

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
    const main = readFileSync('src/main/main.ts', 'utf8');
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
    const main = readFileSync('src/main/main.ts', 'utf8');
    const bootstrap = readFileSync('src/main/bootstrap-controller.ts', 'utf8');
    const daemonManager = readFileSync('src/main/daemon-manager.ts', 'utf8');

    expect(main).toContain("app.getPath('documents')");
    expect(bootstrap).toContain('defaultProjectRoot: this.input.defaultProjectRoot');
    expect(daemonManager).toContain(
      'CLAWEE_DEFAULT_PROJECT_ROOT: input.defaultProjectRoot'
    );
  });
});
