import { stat } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function removeLegacyCodexRuntimeCaches(
  dataDir: string
): Promise<void> {
  await rm(
    join(resolve(dataDir), 'codex', 'rollback-runtimes'),
    { recursive: true, force: true }
  );
}

export async function removeLegacyVersionedCodexHomes(input: {
  dataDir: string;
  stableHome: string;
  layoutVersion: number;
}): Promise<boolean> {
  const marker = join(
    resolve(input.stableHome),
    '.clawee',
    `runtime-home-layout-${input.layoutVersion}`
  );
  try {
    if (!(await stat(marker)).isFile()) return false;
  } catch {
    return false;
  }
  await rm(
    join(resolve(input.dataDir), 'codex', 'homes'),
    { recursive: true, force: true }
  );
  return true;
}
