import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  notarizeArtifact,
  notarytoolCredentialArgs,
  stapleArtifact
} from './macos-notarization.mjs';

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const credentialArgs = notarytoolCredentialArgs(
    process.env,
    process.env.CLAWEE_APPLE_TEAM_ID?.trim() || process.env.APPLE_TEAM_ID?.trim()
  );
  const directory = mkdtempSync(join(tmpdir(), 'clawee-notary-'));
  try {
    const archive = join(directory, 'app.zip');
    const result = spawnSync('ditto', [
      '-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archive
    ], { encoding: 'utf8', timeout: 5 * 60_000 });
    if (result.status !== 0) {
      throw new Error(`公证归档失败：${result.stderr || result.error?.message}`);
    }
    await notarizeArtifact(archive, credentialArgs);
    await stapleArtifact(appPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
