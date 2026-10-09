import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, autoUpdater: {} }));
import { verifyUpdateFile } from '../src/main/customer-update-native.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('原生更新器校验与锁定v6源码契约（不代表真实升级）', () => {
  it('校验真实文件字节与size，损坏文件不能通过声明绕过', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-update-file-'));
    roots.push(directory);
    const path = join(directory, 'update.zip');
    const bytes = Buffer.from('downloaded zip bytes');
    const metadata = { size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') };
    writeFileSync(path, bytes);
    await expect(verifyUpdateFile(path, metadata)).resolves.toBeUndefined();
    writeFileSync(path, Buffer.alloc(bytes.length, 1));
    await expect(verifyUpdateFile(path, metadata)).rejects.toThrow('SHA512');
    writeFileSync(path, 'short');
    await expect(verifyUpdateFile(path, metadata)).rejects.toThrow('大小');
  });

  it('执行实际锁定MacUpdater的下载完成路径：不触发原生检查/替换，明确安装才触发', () => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-locked-mac-updater-'));
    roots.push(directory);
    const artifact = join(directory, 'update.zip');
    writeFileSync(artifact, 'local zip fixture');
    const requireFrom = createRequire(import.meta.url);
    const entry = requireFrom.resolve('electron-updater');
    const script = `
      const assert = require('node:assert/strict');
      const { EventEmitter } = require('node:events');
      const Module = require('node:module');
      const native = new EventEmitter();
      let checked = 0, installed = 0;
      native.setFeedURL = () => undefined;
      native.checkForUpdates = () => { checked += 1; queueMicrotask(() => native.emit('update-downloaded')); };
      native.quitAndInstall = () => { installed += 1; };
      const originalLoad = Module._load;
      Module._load = function(name, ...args) { return name === 'electron' ? { autoUpdater: native } : originalLoad.call(this, name, ...args); };
      const { MacUpdater } = require(${JSON.stringify(entry)});
      const adapter = { version: '0.1.8', name: 'Clawee', isPackaged: true, appUpdateConfigPath: '', userDataPath: ${JSON.stringify(directory)}, baseCachePath: ${JSON.stringify(directory)}, whenReady: async () => {}, onQuit: () => {}, quit: () => {}, relaunch: () => {} };
      (async () => {
        const updater = new MacUpdater(undefined, adapter);
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.logger = null;
        let downloaded = false;
        updater.on('update-downloaded', () => { downloaded = true; });
        await updater.updateDownloaded({ url: new URL('https://files.example/update.zip'), info: { size: 17 } }, { version: '0.1.9', downloadedFile: ${JSON.stringify(artifact)} });
        assert.equal(downloaded, true);
        assert.equal(checked, 0);
        assert.equal(installed, 0);
        adapter.quit();
        const nextLaunch = new MacUpdater(undefined, adapter);
        nextLaunch.autoInstallOnAppQuit = false;
        assert.equal(checked, 0);
        assert.equal(installed, 0);
        updater.quitAndInstall();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(checked, 1);
        assert.equal(installed, 1);
        nextLaunch.closeServerIfExists();
        console.log('locked v6 download/no-quit-install contract passed');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 })).toContain('contract passed');
  });

  it('锁定v6的普通退出钩子检查autoInstallOnAppQuit，mac下载前不向Squirrel请求', () => {
    const requireFrom = createRequire(import.meta.url);
    const out = dirname(requireFrom.resolve('electron-updater'));
    const mac = readFileSync(join(out, 'MacUpdater.js'), 'utf8');
    const base = readFileSync(join(out, 'BaseUpdater.js'), 'utf8');
    const nsis = readFileSync(join(out, 'NsisUpdater.js'), 'utf8');
    expect(mac).toMatch(/dispatchUpdateDownloaded\(event\);\s*if \(this.autoInstallOnAppQuit\)/);
    expect(base).toContain('!this.autoInstallOnAppQuit');
    expect(nsis).toContain('publisherName == null');
    const ours = readFileSync('src/main/customer-update-native.ts', 'utf8');
    expect(ours).toContain('autoInstallOnAppQuit = false');
    expect(ours).toContain('autoDownload = false');
    expect(ours).toContain('disableWebInstaller = true');
    const download = ours.slice(ours.indexOf('async download('), ours.indexOf('async install('));
    expect(download).not.toContain('squirrelUpdater.checkForUpdates');
    expect(download).not.toContain('quitAndInstall');
    expect(ours).toContain('verifyUpdateCodeSignature(publishers, downloadedFile)');
    expect(ours).toContain("['--verify', '--deep', '--strict', bundle]");
  });
});
