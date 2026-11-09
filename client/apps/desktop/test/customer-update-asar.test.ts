import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPackage } from '@electron/asar';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'darwin')('macOS 更新 ASAR 清理（真实 Electron 文件系统，原生校验边界 fake）', () => {
  it('包含真实 ASAR 的校验目录能清理完成，下载不会停在 100%', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-update-asar-test-'));
    roots.push(root);
    const contents = join(root, 'contents');
    mkdirSync(contents);
    writeFileSync(join(contents, 'fixture.txt'), 'asar fixture');
    const archive = join(root, 'app.asar');
    await createPackage(contents, archive);
    const downloadedFile = join(root, 'update.zip');
    const bytes = Buffer.from('download fixture');
    writeFileSync(downloadedFile, bytes);
    const artifact = {
      platform: 'macos', arch: 'arm64', url: 'https://files.example/Clawee.zip',
      sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length
    };
    const release = {
      kind: 'customer-desktop-update', gateway_url: 'https://customer.example.com',
      version: '0.1.9', notes: '', revision: 7, published_at: '2026-10-13T00:00:00Z',
      packages: [artifact]
    };
    const sourcePath = resolve('src/main/customer-update-native.ts');
    const compiled = buildSync({
      entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false,
      external: ['electron', 'electron-updater', 'original-fs', './customer-update.js'],
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(sourcePath).href) }
    }).outputFiles[0]!.text;
    const script = `
      const assert = require('node:assert/strict');
      const { EventEmitter } = require('node:events');
      const fs = require('node:fs');
      const originalFs = require('original-fs');
      const { join, dirname } = require('node:path');
      const { promisify } = require('node:util');
      const Module = require('node:module');
      const artifact = ${JSON.stringify(artifact)};
      const release = ${JSON.stringify(release)};
      let directory;
      const noAsar = process.noAsar;
      assert.equal(fs.statSync(${JSON.stringify(archive)}).isDirectory(), true);
      assert.equal(originalFs.statSync(${JSON.stringify(archive)}).isFile(), true);
      const execute = async (command, args) => {
        if (command === '/usr/bin/ditto') {
          directory = args[3];
          const resources = join(directory, 'Clawee.app/Contents/Resources');
          originalFs.mkdirSync(resources, { recursive: true });
          originalFs.copyFileSync(${JSON.stringify(archive)}, join(resources, 'app.asar'));
          originalFs.copyFileSync(${JSON.stringify(archive)}, join(resources, 'default_app.asar'));
        }
        return {
          stdout: command === '/usr/bin/plutil'
            ? args[1] === 'CFBundleIdentifier' ? 'work.clawee.desktop' : release.version : '',
          stderr: 'TeamIdentifier=CLAWEETEAM'
        };
      };
      class MacUpdater extends EventEmitter {
        async downloadUpdate() {
          this.emit('update-downloaded', {
            version: release.version, releaseNotes: release.notes,
            files: [artifact], downloadedFile: ${JSON.stringify(downloadedFile)}
          });
        }
      }
      const originalLoad = Module._load;
      Module._load = function(name, ...args) {
        if (name === 'electron') return {
          app: { getPath: () => '/Applications/Clawee.app/Contents/MacOS/Clawee' }, autoUpdater: {}
        };
        if (name === 'electron-updater') return { MacUpdater };
        if (name === 'node:child_process') return {
          execFile: Object.assign(() => {}, { [promisify.custom]: execute })
        };
        if (name === './customer-update.js') return { assertNativeMetadata: () => {} };
        if (name === 'node:fs/promises') return {
          ...originalLoad.call(this, name, ...args), access: async () => {}, statfs: async () => ({ bavail: 100000000, bsize: 4096 })
        };
        return originalLoad.call(this, name, ...args);
      };
      const sourcePath = ${JSON.stringify(sourcePath)};
      const loaded = new Module(sourcePath);
      loaded.paths = Module._nodeModulePaths(dirname(sourcePath));
      loaded._compile(${JSON.stringify(compiled)}, sourcePath);
      (async () => {
        try {
          const adapter = loaded.exports.createCustomerNativeUpdater('darwin');
          await adapter.download(release, artifact);
          assert.equal(originalFs.existsSync(directory), false);
          assert.equal(process.noAsar, noAsar);
          assert.equal(fs.statSync(${JSON.stringify(archive)}).isDirectory(), true);
          console.log('Electron ASAR cleanup passed');
        } finally {
          if (directory) originalFs.rmSync(directory, { recursive: true, force: true });
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const requireFrom = createRequire(import.meta.url);
    const electron = requireFrom('electron') as string;
    expect(execFileSync(electron, ['-e', script], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TMPDIR: root, TMP: root, TEMP: root }
    })).toContain('Electron ASAR cleanup passed');
  });
});
