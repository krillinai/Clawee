import { execFile, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { WorkspaceFileError } from './errors.js';

const execFileAsync = promisify(execFile);

export type RevealExecutor = (request: { absolutePath: string; mode: 'file' | 'directory' }) => Promise<void> | void;

export const defaultRevealExecutor: RevealExecutor = async ({ absolutePath, mode }) => {
  if (platform() === 'win32') {
    const child = spawn('explorer.exe', mode === 'file' ? ['/select,', absolutePath] : [absolutePath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    // Explorer may keep running or exit with code 1 after handing off a window.
    // Successful process creation is the completion signal for this action.
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
    return;
  }
  if (platform() !== 'darwin') {
    throw new WorkspaceFileError('REVEAL_UNAVAILABLE', 'Reveal is not supported on this platform.');
  }
  const args = mode === 'file' ? ['-R', absolutePath] : [absolutePath];
  await execFileAsync('open', args);
};

export function createDefaultRevealExecutor(): RevealExecutor {
  return defaultRevealExecutor;
}
