import { describe, expect, it } from 'vitest';
import { shouldUseShell } from '../scripts/script-utils.mjs';

describe('Desktop package process launcher', () => {
  it('launches Windows executables directly even when their path contains spaces', () => {
    expect(shouldUseShell('D:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(false);
    expect(shouldUseShell('C:\\Tools\\runner.com', 'win32')).toBe(false);
  });

  it('uses the Windows shell for command shims', () => {
    expect(shouldUseShell('pnpm', 'win32')).toBe(true);
    expect(shouldUseShell('npm.cmd', 'win32')).toBe(true);
    expect(shouldUseShell('electron-builder', 'win32')).toBe(true);
  });

  it('does not use a shell on other platforms', () => {
    expect(shouldUseShell('pnpm', 'darwin')).toBe(false);
    expect(shouldUseShell('pnpm', 'linux')).toBe(false);
  });
});
