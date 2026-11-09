import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdtemp, readdir, rm, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { app, autoUpdater as squirrelUpdater } from 'electron';
import updaterModule from 'electron-updater';
import type { UpdateDownloadedEvent } from 'electron-updater';
import { promises as originalFs } from 'original-fs';
import { assertNativeMetadata, stableVersion, type CustomerUpdatePackage, type CustomerUpdateRelease, type NativeUpdateAdapter } from './customer-update.js';
import type { DesktopLogger } from './logger.js';
import { CustomerUpdateError, updateErrorCode } from './customer-update-error.js';

const { MacUpdater, NsisUpdater } = updaterModule;
const execute = promisify(execFile);
const SQUIRREL_READY_TIMEOUT_MS = 120_000;

export function createCustomerNativeUpdater(
  platform: NodeJS.Platform,
  prepareQuit: () => void = () => {},
  logger?: DesktopLogger
): NativeUpdateAdapter | undefined {
  if (platform !== 'darwin' && platform !== 'win32') return undefined;
  const updater = platform === 'darwin' ? new MacUpdater() : new NsisUpdater();
  const installDirectory = platform === 'win32' ? dirname(app.getPath('exe')) : undefined;
  if (platform === 'win32') {
    // Windows 允许未签名 NSIS 包，更新包仍须匹配 Gateway 批准快照和摘要。
    const windowsUpdater = updater as InstanceType<typeof NsisUpdater>;
    windowsUpdater.installDirectory = installDirectory;
    windowsUpdater.verifyUpdateCodeSignature = async () => null;
  }
  if (logger !== undefined) updater.logger = {
    info: (...messages) => logger.info('Native updater', { message: messages.map(String).join(' ') }),
    warn: (...messages) => logger.warn('Native updater', { message: messages.map(String).join(' ') }),
    error: (...messages) => logger.error('Native updater', { message: messages.map(String).join(' ') })
  };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  updater.requestHeaders = { 'Cache-Control': 'no-cache' };
  let downloadedFile: string | undefined;
  let downloadedVersion: string | undefined;
  let operationError: Error | undefined;
  let installationStarted = false;
  let handedOff = false;
  let nativeUncertain = false;
  let verifiedHash: string | undefined;
  let verifiedFileIdentity: string | undefined;
  updater.on('error', error => { operationError = error; });

  const verify = async (artifact: CustomerUpdatePackage, final = false) => {
    if (downloadedFile === undefined) throw new Error('更新包尚未下载');
    const identity = await updateFileIdentity(downloadedFile);
    await verifyUpdateFile(downloadedFile, artifact);
    if (identity !== await updateFileIdentity(downloadedFile)) throw new CustomerUpdateError('PACKAGE_CORRUPT', '更新包在校验期间被替换，请重新下载');
    if (verifiedHash === artifact.sha512 && verifiedFileIdentity === identity) return;
    if (final) throw new CustomerUpdateError('PACKAGE_NOT_VERIFIED', '缺少当前包的后台校验结果');
    const installationDirectory = dirname(dirname(dirname(app.getPath('exe'))));
    const writableDirectory = platform === 'darwin' ? dirname(installationDirectory) : dirname(app.getPath('exe'));
    await access(writableDirectory, constants.W_OK);
    const space = await statfs(writableDirectory);
    if (space.bavail * space.bsize < artifact.size * 3) throw new CustomerUpdateError('INSUFFICIENT_SPACE', '更新所需磁盘空间不足');
    try {
      if (platform === 'darwin') {
        await verifyMacUpdate(downloadedFile, installationDirectory, downloadedVersion);
      }
    } catch (error) {
      if (error instanceof CustomerUpdateError) throw error;
      const code = updateErrorCode(error);
      if (code === 'INSUFFICIENT_SPACE' || code === 'PERMISSION_DENIED') throw new CustomerUpdateError(code, '更新包校验失败，请检查磁盘空间和权限');
      throw new CustomerUpdateError('SIGNATURE_FAILED', '更新包签名、产品身份或解压检查失败');
    }
    if (identity !== await updateFileIdentity(downloadedFile)) throw new CustomerUpdateError('PACKAGE_CORRUPT', '更新包在校验期间被替换，请重新下载');
    verifiedHash = artifact.sha512;
    verifiedFileIdentity = identity;
  };

  return {
    async check(feed, simulatedVersion) {
      if (nativeUncertain || handedOff) throw new CustomerUpdateError('NATIVE_RESULT_UNKNOWN', '原生更新结果待确认，请重新打开应用后重试');
      operationError = undefined;
      updater.setFeedURL({ provider: 'generic', url: feed, useMultipleRangeRequest: false });
      if (simulatedVersion !== undefined && !stableVersion(simulatedVersion)) throw new Error('模拟起始版本无效');
      // 只临时调整此实例的 SemVer 比较对象，保留原有网络、包校验及平台安装器。
      const actualVersion = simulatedVersion !== undefined ? { ...updater.currentVersion } : undefined;
      try {
        if (actualVersion && simulatedVersion !== undefined) {
          const [major, minor, patch] = simulatedVersion.split('.').map(Number);
          Object.assign(updater.currentVersion, { major, minor, patch, version: simulatedVersion, raw: simulatedVersion });
        }
        const result = await updater.checkForUpdates();
        if (operationError !== undefined) throw operationError;
        return result?.updateInfo;
      } finally {
        if (actualVersion) Object.assign(updater.currentVersion, actualVersion);
      }
    },
    async download(release: CustomerUpdateRelease, artifact: CustomerUpdatePackage) {
      if (nativeUncertain || handedOff) throw new CustomerUpdateError('NATIVE_RESULT_UNKNOWN', '原生更新结果待确认，请重新打开应用后重试');
      operationError = undefined;
      downloadedFile = undefined;
      verifiedHash = undefined;
      verifiedFileIdentity = undefined;
      downloadedVersion = release.version;
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
    async discard() {
      // 只删除本适配器确认的包，不递归清空更新缓存或其他版本。
      if (downloadedFile) await rm(downloadedFile, { force: true });
      downloadedFile = undefined;
      verifiedHash = undefined;
      verifiedFileIdentity = undefined;
    },
    async install(authorizeQuit, signal) {
      if (installationStarted || handedOff || nativeUncertain) throw new CustomerUpdateError('NATIVE_RESULT_UNKNOWN', '原生安装结果待确认，请重新打开应用后重试');
      signal?.throwIfAborted();
      installationStarted = true;
      try {
        operationError = undefined;
        logger?.info('Native update installation requested', {
          platform,
          targetVersion: downloadedVersion,
          ...(installDirectory === undefined ? {} : { installDirectory })
        });
        if (logger !== undefined) await logger.flush();
        signal?.throwIfAborted();
        if (platform === 'darwin') {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              squirrelUpdater.removeListener('update-downloaded', ready);
              squirrelUpdater.removeListener('error', failed);
              clearTimeout(timeout);
              signal?.removeEventListener('abort', aborted);
            };
            let settled = false;
            const ready = () => { if (settled) return; settled = true; cleanup(); resolve(); };
            const failed = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
            const aborted = () => { nativeUncertain = true; failed(new CustomerUpdateError('INSTALL_CANCELLED', '更新准备已取消')); };
            const timeout = setTimeout(() => {
              nativeUncertain = true;
              failed(new CustomerUpdateError('NATIVE_PREPARE_TIMEOUT', 'macOS 原生更新准备超时，已取消安装'));
            }, SQUIRREL_READY_TIMEOUT_MS);
            signal?.addEventListener('abort', aborted, { once: true });
            squirrelUpdater.once('update-downloaded', ready);
            squirrelUpdater.once('error', failed);
            try { squirrelUpdater.checkForUpdates(); } catch (error) {
              cleanup();
              reject(error);
            }
          });
        }
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            app.removeListener('before-quit', quitting);
            updater.removeListener('error', failed);
            clearTimeout(timeout);
          };
          const quitting = () => { cleanup(); resolve(); };
          const failed = (error: Error) => { cleanup(); reject(error); };
          const timeout = setTimeout(() => failed(new CustomerUpdateError('NATIVE_EXIT_TIMEOUT', '原生更新器未确认安装退出，请退出并重新打开应用确认结果')), 10_000);
          app.once('before-quit', quitting);
          updater.once('error', failed);
          try { authorizeQuit(); handedOff = true; prepareQuit(); updater.quitAndInstall(platform === 'win32', true); } catch (error) {
            cleanup();
            reject(error);
          }
        });
      } finally { installationStarted = false; }
    },
    onProgress(listener) {
      updater.on('download-progress', info => listener(info.percent));
    }
  };
}

async function updateFileIdentity(path: string): Promise<string> {
  const metadata = await lstat(path);
  return JSON.stringify([path, metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs]);
}

export async function verifyUpdateFile(path: string, artifact: Pick<CustomerUpdatePackage, 'sha512' | 'size'>): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size !== artifact.size) throw new CustomerUpdateError('PACKAGE_CORRUPT', '更新包大小校验失败，请重新下载');
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const after = await lstat(path);
  if (digest.digest('base64') !== artifact.sha512 || metadata.ino !== after.ino || metadata.dev !== after.dev
    || metadata.mtimeMs !== after.mtimeMs || metadata.ctimeMs !== after.ctimeMs) throw new CustomerUpdateError('PACKAGE_CORRUPT', '更新包 SHA512 校验失败，请重新下载');
}

async function verifyMacUpdate(archive: string, installedApp: string, expectedVersion: string | undefined): Promise<void> {
  const installedTeam = await signedMacTeam(installedApp);
  const directory = await mkdtemp(join(tmpdir(), 'clawee-update-verify-'));
  try {
    await execute('/usr/bin/ditto', ['-x', '-k', archive, directory], { timeout: 120_000 });
    const bundles = (await readdir(directory)).filter(name => name.endsWith('.app'));
    if (bundles.length !== 1) throw new Error('更新 ZIP 必须包含一个应用');
    const updatedApp = join(directory, bundles[0]!);
    if (await signedMacTeam(updatedApp) !== installedTeam) {
      throw new Error('更新应用与已安装应用的签名 TeamIdentifier 不一致');
    }
    const readProperty = async (bundle: string, key: string) => (await execute('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')], { timeout: 20_000 })).stdout.trim();
    if (await readProperty(updatedApp, 'CFBundleIdentifier') !== await readProperty(installedApp, 'CFBundleIdentifier')
      || await readProperty(updatedApp, 'CFBundleShortVersionString') !== expectedVersion) {
      throw new Error('更新应用的产品身份或真实版本与目标版本不一致');
    }
  } finally {
    await originalFs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch(error => { console.warn('更新校验临时目录清理失败', error); });
  }
}

async function signedMacTeam(bundle: string): Promise<string> {
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120_000 });
  const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=4', bundle], { timeout: 20_000 });
  const team = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(stderr)?.[1];
  if (team === undefined || team === 'not') throw new Error('macOS 自动更新需要真实签名应用，不接受临时签名');
  return team;
}
