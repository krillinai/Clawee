import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { collectUpdateArtifacts, refreshUpdateMetadata } from '../scripts/release-artifacts.mjs';

it('收集完整更新文件并重算最终签名文件的校验和', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-update-'));
  try {
    writeFileSync(join(directory, 'Clawee.dmg'), 'stapled-dmg');
    writeFileSync(join(directory, 'Clawee.zip'), 'signed-zip');
    writeFileSync(join(directory, 'latest-mac.yml'), 'version: 1.1.0\npath: Clawee.zip\nsha512: stale\nfiles:\n  - url: Clawee.zip\n    sha512: stale\n  - url: Clawee.dmg\n    sha512: stale\n');
    const files = collectUpdateArtifacts(directory, Date.now() - 1000, 'darwin');
    expect(files).toHaveLength(3);
    refreshUpdateMetadata(files);
    const result = readFileSync(join(directory, 'latest-mac.yml'), 'utf8');
    expect(result).not.toContain('stale');
    expect(result).toContain(createHash('sha512').update('stapled-dmg').digest('base64'));
    writeFileSync(join(directory, 'latest-mac.yml'), 'files:\n  - url: ../unverified.zip\n');
    expect(() => refreshUpdateMetadata(files)).toThrow('本次构建之外');
    rmSync(join(directory, 'Clawee.zip'));
    expect(() => collectUpdateArtifacts(directory, Date.now() - 1000, 'darwin')).toThrow('缺失/重复');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
