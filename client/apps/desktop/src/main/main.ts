import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { createDesktopLogger } from './logger.js';
import { registerPrivilegedSchemes } from './protocol-handler.js';
import { waitForWindowsInstall, windowsUpdateNeedsRelaunch } from './windows-install-state.js';
import { CustomerUpdateJournal } from './customer-update-record.js';
import { prepareUnencryptedCookieStore } from './cookie-store.js';

registerPrivilegedSchemes();
app.setName('Clawee');
app.commandLine.appendSwitch('lang', 'zh-CN');
const appEntryAt = Date.now();
const earlyLaunchArguments: string[] = [];
const queueEarlyUrl = (event: Electron.Event, url: string) => {
  event.preventDefault();
  earlyLaunchArguments.push(url);
};
const queueEarlyArguments = (_event: Electron.Event, argv: string[]) => {
  earlyLaunchArguments.push(...argv.filter(value => value.startsWith('clawee://')));
};
app.on('open-url', queueEarlyUrl);
app.on('second-instance', queueEarlyArguments);
// 安装等待窗口关闭后仍需继续启动，工作台也需要保持托盘运行。
app.on('window-all-closed', () => {});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void start().catch(error => {
    console.error(`Clawee Desktop failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    app.exit(1);
  });
}

async function start(): Promise<void> {
  prepareUnencryptedCookieStore(app.getPath('sessionData'));
  if (process.platform === 'win32' && app.isPackaged) {
    await app.whenReady();
    const logger = createDesktopLogger(join(app.getPath('userData'), 'logs', 'desktop-main.log'));
    const controller = new AbortController();
    let waitingWindow: BrowserWindow | undefined;
    const showWaitingWindow = () => waitingWindow?.show();
    app.on('second-instance', showWaitingWindow);
    try {
      const version = app.getVersion();
      const state = await waitForWindowsInstall({
        installDirectory: dirname(process.resourcesPath),
        signal: controller.signal,
        onWaiting: async state => {
          logger.info('Windows update installation in progress', { ...state, version });
          const assets = join(app.getAppPath(), 'dist', 'bootstrap', 'assets');
          const files = readdirSync(assets);
          const css = readFileSync(join(assets, files.find(file => file.endsWith('.css'))!), 'utf8');
          const logo = readFileSync(join(assets, files.find(file => /^logo-.*\.png$/.test(file))!)).toString('base64');
          waitingWindow = new BrowserWindow({
            width: 560, height: 420, resizable: false, title: 'Clawee',
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: false }
          });
          waitingWindow.on('close', () => controller.abort());
          await waitingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>${css}</style></head><body><main class="bootstrap-shell"><section class="bootstrap-panel"><img class="brand-mark" src="data:image/png;base64,${logo}" alt="Clawee"><div class="status-mark"><span></span></div><h1>Clawee 正在完成更新</h1><p id="status-detail">正在写入客户端文件，请稍候。</p></section></main></body></html>`)}`);
        }
      });
      if (state?.targetVersion === version || state?.waited) {
        logger.info('Windows update installation completed', { ...state, version });
      }
      await logger.flush();
      const marker = `--clawee-update-relaunch=${state?.targetVersion}`;
      if (windowsUpdateNeedsRelaunch(state, version, process.argv.includes(marker))) {
        app.relaunch({ args: [...process.argv.slice(1), marker] });
        app.exit(0);
        return;
      }
    } catch (error) {
      if (controller.signal.aborted) { app.quit(); return; }
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Windows update startup blocked', { message });
      const journal = new CustomerUpdateJournal(join(app.getPath('userData'), 'customer-update-state.json'));
      for (const record of journal.reconcileStartup(app.getVersion())) {
        try { journal.save({ ...record, phase: 'paused', errorCode: 'LOCAL_INITIALIZATION_FAILED' }); } catch { break; }
      }
      await logger.flush();
      const choice = await dialog.showMessageBox({ type: 'error', title: 'Clawee 更新安装未完成', message,
        buttons: ['打开官方安装包', '退出'], defaultId: 1, cancelId: 1 });
      if (choice.response === 0) await shell.openExternal('https://github.com/krillinai/Clawee/releases');
      app.quit();
      return;
    } finally {
      app.removeListener('second-instance', showWaitingWindow);
      waitingWindow?.removeAllListeners('close');
      waitingWindow?.destroy();
    }
  }
  // 安装器完成写入后才加载可能依赖外部资源的主进程模块。
  const { launchDesktop } = await import('./desktop-main.js');
  app.removeListener('open-url', queueEarlyUrl);
  app.removeListener('second-instance', queueEarlyArguments);
  await launchDesktop(appEntryAt, earlyLaunchArguments);
}
