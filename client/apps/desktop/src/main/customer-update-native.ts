import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { app, autoUpdater as squirrelUpdater } from 'electron';
import updaterModule from 'electron-updater';
import type { UpdateDownloadedEvent } from 'electron-updater';
import { assertNativeMetadata, type CustomerUpdatePackage, type CustomerUpdateRelease, type NativeUpdateAdapter } from './customer-update.js';

const { MacUpdater, NsisUpdater } = updaterModule;
const execute = promisify(execFile);
const { load } = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };
const SQUIRREL_READY_TIMEOUT_MS = 120_000;

export function createCustomerNativeUpdater(platform: NodeJS.Platform): NativeUpdateAdapter | undefined {
  if (platform !== 'darwin' && platform !== 'win32') return undefined;
  const updater = platform === 'darwin' ? new MacUpdater() : new NsisUpdater();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  updater.requestHeaders = { 'Cache-Control': 'no-cache' };
  let downloadedFile: string | undefined;
  let operationError: Error | undefined;
  updater.on('error', error => { operationError = error; });

  const verify = async (artifact: CustomerUpdatePackage) => {
    if (downloadedFile === undefined) throw new Error('更新包尚未下载');
    await verifyUpdateFile(downloadedFile, artifact);
    if (platform === 'darwin') {
      await verifyMacUpdate(downloadedFile, dirname(dirname(dirname(app.getPath('exe')))));
    } else {
      const publishers = await readWindowsUpdatePublishers();
      const error = await (updater as InstanceType<typeof NsisUpdater>).verifyUpdateCodeSignature(publishers, downloadedFile);
      if (error !== null) throw new Error(`更新包签名校验失败：${error}`);
    }
  };

  return {
    async check(feed) {
      operationError = undefined;
      updater.setFeedURL({ provider: 'generic', url: feed, useMultipleRangeRequest: false });
      const result = await updater.checkForUpdates();
      if (operationError !== undefined) throw operationError;
      return result?.updateInfo;
    },
    async download(release: CustomerUpdateRelease, artifact: CustomerUpdatePackage) {
      operationError = undefined;
      downloadedFile = undefined;
      if (platform === 'win32') await readWindowsUpdatePublishers();
      let eventError: unknown;
      const downloaded = (event: UpdateDownloadedEvent) => {
        const { downloadedFile: file, ...info } = event;
        try {
          assertNativeMetadata(info, release, artifact);
          if (typeof file !== 'string') throw new Error('原生更新器未返回更新文件');
          downloadedFile = file;
        } catch (error) {
          eventError = error;
        }
      };
      updater.on('update-downloaded', downloaded);
      try {
        await updater.downloadUpdate();
        if (operationError !== undefined) throw operationError;
        if (eventError !== undefined) throw eventError;
        await verify(artifact);
      } finally {
        updater.removeListener('update-downloaded', downloaded);
      }
    },
    verify,
    async install(authorizeQuit) {
      operationError = undefined;
      if (platform === 'darwin') {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            squirrelUpdater.removeListener('update-downloaded', ready);
            squirrelUpdater.removeListener('error', failed);
            clearTimeout(timeout);
          };
          const ready = () => { cleanup(); resolve(); };
          const failed = (error: Error) => { cleanup(); reject(error); };
          const timeout = setTimeout(() => failed(new Error('macOS 原生更新准备超时，已取消安装')), SQUIRREL_READY_TIMEOUT_MS);
          squirrelUpdater.once('update-downloaded', ready);
          squirrelUpdater.once('error', failed);
          try { squirrelUpdater.checkForUpdates(); } catch (error) {
            cleanup();
            reject(error);
          }
        });
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          app.removeListener('before-quit', quitting);
          updater.removeListener('error', failed);
          clearTimeout(timeout);
        };
        const quitting = () => { cleanup(); resolve(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const timeout = setTimeout(() => failed(new Error('原生更新器未确认安装退出')), 10_000);
        app.once('before-quit', quitting);
        updater.once('error', failed);
        try { authorizeQuit(); updater.quitAndInstall(false, true); } catch (error) {
          cleanup();
          reject(error);
        }
      });
    },
    onProgress(listener) {
      updater.on('download-progress', info => listener(info.percent));
    }
  };
}

export async function verifyUpdateFile(path: string, artifact: Pick<CustomerUpdatePackage, 'sha512' | 'size'>): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size !== artifact.size) throw new Error('更新包大小校验失败，请重新下载');
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  if (digest.digest('base64') !== artifact.sha512) throw new Error('更新包 SHA512 校验失败，请重新下载');
}

async function readWindowsUpdatePublishers(): Promise<string[]> {
  const config = load(await readFile(join(process.resourcesPath, 'app-update.yml'), 'utf8'));
  const publisher = typeof config === 'object' && config !== null && 'publisherName' in config
    ? config.publisherName : undefined;
  const publishers = Array.isArray(publisher) ? publisher : [publisher];
  if (publishers.length === 0 || publishers.some(value => typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error('当前安装包缺少 Windows 签名发布者，不能安全更新');
  }
  return publishers as string[];
}

async function verifyMacUpdate(archive: string, installedApp: string): Promise<void> {
  const installedTeam = await signedMacTeam(installedApp);
  const directory = await mkdtemp(join(tmpdir(), 'clawee-update-verify-'));
  try {
    await execute('/usr/bin/ditto', ['-x', '-k', archive, directory], { timeout: 120_000 });
    const bundles = (await readdir(directory)).filter(name => name.endsWith('.app'));
    if (bundles.length !== 1) throw new Error('更新 ZIP 必须包含一个应用');
    if (await signedMacTeam(join(directory, bundles[0]!)) !== installedTeam) {
      throw new Error('更新应用与已安装应用的签名 TeamIdentifier 不一致');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function signedMacTeam(bundle: string): Promise<string> {
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120_000 });
  const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=4', bundle], { timeout: 20_000 });
  const team = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(stderr)?.[1];
  if (team === undefined || team === 'not') throw new Error('macOS 自动更新需要真实签名应用，不接受临时签名');
  return team;
}
