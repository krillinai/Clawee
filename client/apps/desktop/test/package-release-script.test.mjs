import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageScript = readFileSync(
  resolve(process.cwd(), 'scripts/package-release.mjs'),
  'utf8'
);
const verifyScript = readFileSync(
  resolve(process.cwd(), 'scripts/verify-package.mjs'),
  'utf8'
);
const builderConfig = readFileSync(
  resolve(process.cwd(), 'electron-builder.yml'),
  'utf8'
);

describe('Desktop package release script', () => {
  it('allows pnpm to fill missing optional dependency metadata during deploy', () => {
    const deploymentStage = packageScript.match(
      /await runStage\('部署 Desktop 主进程生产依赖'[\s\S]*?\n\}\);/
    )?.[0];

    expect(deploymentStage).toContain("'--prefer-offline'");
    expect(deploymentStage).not.toContain("'--offline'");
  });

  it('prepares and records the embedded Codex Runtime before packaging', () => {
    const desktopBuild = packageScript.indexOf("'构建 Desktop'");
    const runtimePreparation = packageScript.indexOf("'准备 Codex Runtime'");
    const runtimeContract = packageScript.indexOf(
      "'验证 Codex app-server 发布契约'"
    );
    const electronBuilder = packageScript.indexOf(
      "'electron-builder',",
      runtimePreparation
    );

    expect(desktopBuild).toBeGreaterThan(-1);
    expect(runtimePreparation).toBeGreaterThan(desktopBuild);
    expect(runtimeContract).toBeGreaterThan(runtimePreparation);
    expect(electronBuilder).toBeGreaterThan(runtimeContract);
    expect(packageScript).toContain(
      "'scripts/codex-runtime/app-server-release-contract.mjs'"
    );
    expect(packageScript).toContain('`--runtime-dir=${codexRuntimeStage}`');
    expect(packageScript).toContain('version: 2');
    for (const field of [
      'codexRuntimeId',
      'codexRuntimeVersion',
      'codexRuntimeReleaseTag',
      'codexRuntimeTarget',
      'codexRuntimeLayoutVersion',
      'codexRuntimeEntrypoint',
      'codexRuntimeFileCount',
      'codexRuntimeContentSha256',
      'codexRuntimeArchiveSha256'
    ]) {
      expect(packageScript).toContain(field);
    }
    expect(packageScript).toContain('codex-runtime-package.json');
    expect(packageScript).toContain(
      'cpSync(codexRuntimeManifestSource, codexRuntimeManifestStage)'
    );
    expect(packageScript).toContain(
      "'node_modules/@clawee/protocol/dist/index.js'"
    );
    expect(builderConfig).toContain('from: .pack/codex-runtime');
    expect(builderConfig).toContain('to: codex-runtime');
    expect(builderConfig).toContain('signIgnore:');
    expect(builderConfig).toContain(
      '.*/Contents/Resources/codex-runtime/.*'
    );
    expect(verifyScript).toContain(
      "entry === '/dist/main/codex-resolver.js'"
    );
  });
});
