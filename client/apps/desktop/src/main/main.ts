import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  app,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron';
import { createWindowsApplicationMenuTemplate } from './application-menu.js';
import { BootstrapController } from './bootstrap-controller.js';
import { DaemonManager } from './daemon-manager.js';
import {
  startRuntimeDataImport,
  type RuntimeDataImportTask
} from './data-migration.js';
import {
  deepLinkToRoute,
  findDeepLink
} from './deep-link-manager.js';
import { isDevelopmentWebUrl } from './development-web.js';
import { exportDesktopDiagnostics } from './diagnostics.js';
import {
  resolveDesktopEnterpriseLaunchConfig
} from './enterprise-launch-config-2026-07-30.js';
import {
  ENTERPRISE_CONFIG_FILENAME,
  prepareEnterpriseUserConfig
} from './enterprise-user-config-2026-08-06.js';
import { createDesktopLogger } from './logger.js';
import {
  openExternal,
  revealPath
} from './native-actions.js';
import { NotificationManager } from './notification-manager.js';
import {
  installProtocolHandler,
  registerPrivilegedSchemes
} from './protocol-handler.js';
import { createSettingsStore } from './settings-store.js';
import { TrayManager } from './tray-manager.js';
import { startUpdater } from './updater.js';
import { WindowManager } from './window-manager.js';
import { desktopIpc } from '../shared/ipc.js';
import type {
  DesktopHostNotification,
  DesktopHostResult
} from '../shared/types.js';

registerPrivilegedSchemes();
app.setName('Clawee');
app.commandLine.appendSwitch('lang', 'zh-CN');
const DEVELOPMENT = !app.isPackaged;
const APP_ENTRY_AT = Date.now();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  void launchDesktop().catch(error => {
    console.error(
      `Clawee Desktop failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
    app.exit(1);
  });
}

async function launchDesktop(): Promise<void> {
  const pendingRoutes: string[] = [];
  let windowManager: WindowManager | undefined;
  let bootstrap: BootstrapController | undefined;
  let workspaceLoaded = false;
  let workspaceLoadWork: Promise<void> | undefined;
  let shutdownStarted = false;
  let allowQuit = false;
  let migrationTask: RuntimeDataImportTask | undefined;

  const queueDeepLink = (value: string | undefined) => {
    if (value === undefined) return;
    const route = deepLinkToRoute(value);
    if (route === undefined) return;
    if (!workspaceLoaded || windowManager === undefined) {
      pendingRoutes.push(route);
      return;
    }
    windowManager.show();
    windowManager.send(desktopIpc.navigate, route);
  };

  app.on('open-url', (event, url) => {
    event.preventDefault();
    queueDeepLink(url);
  });
  app.on('second-instance', (_event, argv) => {
    queueDeepLink(findDeepLink(argv));
    windowManager?.show();
  });

  await app.whenReady();
  const appReadyAt = Date.now();
  const development = DEVELOPMENT;
  const appRoot = app.getAppPath();
  const userData = app.getPath('userData');
  const dataDir = join(userData, 'daemon');
  const defaultProjectRoot = process.env.CLAWEE_DEFAULT_PROJECT_ROOT
    ?? app.getPath('documents');
  const logDir = join(userData, 'logs');
  const logger = createDesktopLogger(join(logDir, 'desktop-main.log'));
  const bundledEnterpriseConfigPath = development
    ? resolve(appRoot, '../../config', ENTERPRISE_CONFIG_FILENAME)
    : join(
        process.resourcesPath,
        'deployment',
        ENTERPRISE_CONFIG_FILENAME
      );
  const runtimeManifestPath = development
    ? resolve(appRoot, '../../config/codex-runtime.json')
    : join(process.resourcesPath, 'deployment', 'codex-runtime.json');
  const runtimePackageDescriptorPath = join(
    process.resourcesPath,
    'deployment',
    'codex-runtime-package.json'
  );
  const developmentRuntimeDirectory = resolve(
    appRoot,
    '.pack/codex-runtime'
  );
  const developmentCodexHome = resolve(
    appRoot,
    '.runtime/codex-home'
  );
  const enterpriseLaunchConfig = resolveDesktopEnterpriseLaunchConfig(
    process.argv,
    process.env
  );
  const enterpriseUserConfig = prepareEnterpriseUserConfig({
    bundledPath: bundledEnterpriseConfigPath,
    userPath: enterpriseLaunchConfig.enterpriseE2EConfigPath
      ?? join(app.getPath('home'), '.clawee', ENTERPRISE_CONFIG_FILENAME)
  });
  logger.info('Enterprise gateway config loaded', {
    path: enterpriseUserConfig.path
  });
  const settings = createSettingsStore(join(userData, 'desktop-settings.json'));
  const daemon = new DaemonManager(logger);
  const tray = new TrayManager();
  const daemonEntryPath = development
    ? resolve(appRoot, '.pack/daemon/dist/main.js')
    : join(process.resourcesPath, 'daemon', 'dist', 'main.js');
  const webRoot = development
    ? resolve(appRoot, '../web/dist')
    : join(process.resourcesPath, 'web');
  const bootstrapRoot = join(appRoot, 'dist', 'bootstrap');
  const preloadPath = join(appRoot, 'dist', 'preload', 'index.cjs');
  const resourceRoot = development
    ? join(appRoot, 'resources')
    : join(process.resourcesPath, 'desktop-resources');
  if (development && process.platform === 'darwin') {
    app.dock?.setIcon(join(resourceRoot, 'icon.png'));
  }

  logger.info('Clawee Desktop starting', {
    development,
    appRoot,
    dataDir,
    daemonEntryPath
  });

  bootstrap = new BootstrapController({
    daemon,
    logger,
    daemonEntryPath,
    dataDir,
    defaultProjectRoot,
    development,
    resourcesPath: process.resourcesPath,
    runtimeManifestPath,
    developmentRuntimeDirectory,
    developmentCodexHome,
    ...(development ? {} : { runtimePackageDescriptorPath }),
    claweeVersion: app.getVersion(),
    homeDir:
      enterpriseLaunchConfig.enterpriseE2EHomeDir
      ?? app.getPath('home'),
    enterpriseConfigPath: enterpriseUserConfig.path,
    ...(enterpriseLaunchConfig.enterpriseE2ERunId === undefined
      ? {}
      : {
          enterpriseE2ERunId: enterpriseLaunchConfig.enterpriseE2ERunId
        })
  });
  windowManager = new WindowManager({
    preloadPath,
    settings,
    development,
    appEntryAt: APP_ENTRY_AT,
    workspaceReadyTimeoutMs: parsePositiveInteger(
      process.env.CLAWEE_E2E_WORKSPACE_READY_TIMEOUT_MS
    ),
    requestQuit: () => app.quit()
  });

  const navigate = (route: string) => {
    if (!workspaceLoaded) {
      pendingRoutes.push(route);
      return;
    }
    windowManager?.show();
    windowManager?.send(desktopIpc.navigate, route);
  };
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(Menu.buildFromTemplate(
      createWindowsApplicationMenuTemplate({
        development,
        navigate,
        openLogs: () => {
          void shell.openPath(logDir).then(error => {
            if (error.length > 0) logger.warn('Failed to open desktop log directory', { error });
          });
        },
        showAbout: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: '关于 Clawee',
            message: `Clawee ${app.getVersion()}`,
            detail: '企业级本地 Codex 桌面工作台',
            buttons: ['确定'],
            noLink: true
          });
        },
        quit: () => app.quit()
      })
    ));
  }
  const notifications = new NotificationManager({
    getConnection: () => daemon.currentConnection,
    settings,
    logger,
    navigate
  });
  const loadWorkspace = (): Promise<void> => {
    if (workspaceLoadWork !== undefined) return workspaceLoadWork;
    workspaceLoadWork = (async () => {
      workspaceLoaded = false;
      try {
        await windowManager?.loadWorkspace();
        workspaceLoaded = true;
        bootstrap?.markWorkspaceReady();
        windowManager?.show();
        for (const route of pendingRoutes.splice(0)) {
          windowManager?.send(desktopIpc.navigate, route);
        }
        notifications.start();
      } catch (error) {
        logger.error('Failed to load the Clawee workspace', {
          message: error instanceof Error ? error.message : String(error)
        });
        bootstrap?.markWorkspaceFailed(error);
        await windowManager?.loadBootstrap();
      }
    })().finally(() => {
      workspaceLoadWork = undefined;
    });
    return workspaceLoadWork;
  };

  await installProtocolHandler({
    webRoot,
    bootstrapRoot,
    getConnection: () => daemon.currentConnection,
    logger
  });
  registerIpcHandlers({
    development,
    allowInsecureExternalUrls:
      development || enterpriseLaunchConfig.enterpriseE2ERunId !== undefined,
    ...(enterpriseLaunchConfig.enterpriseE2ERunId === undefined
      ? {}
      : { externalUrlOpener: openEnterpriseE2EExternalUrl }),
    bootstrap,
    daemon,
    notifications,
    windowManager,
    settings,
    dataDir,
    logDir,
    quit: () => app.quit(),
    reloadWorkspace: loadWorkspace
  });
  registerWorkspaceReadyListener({
    development,
    windowManager,
    ignoreFirstReady:
      process.env.CLAWEE_E2E_IGNORE_FIRST_WORKSPACE_READY === '1'
  });

  bootstrap.on('state', state => {
    windowManager?.send(desktopIpc.bootstrapChanged, state);
  });
  bootstrap.on('connection', connection => {
    windowManager?.send(desktopIpc.connectionChanged, connection);
  });
  bootstrap.on('ready', () => {
    void loadWorkspace();
  });

  await windowManager.loadBootstrap();
  bootstrap.setStartupMetrics({
    ...windowManager.metrics,
    appReadyAt
  });
  tray.create({
    iconPath: join(resourceRoot, process.platform === 'darwin' ? 'tray.png' : 'icon.png'),
    open: () => windowManager?.show(),
    navigate,
    quit: () => app.quit()
  });
  registerApplicationProtocol(development, appRoot, logger);
  const updater = startUpdater({
    logger,
    enabled: !development && existsSync(join(process.resourcesPath, 'deployment', 'official-release.json')),
    async prepareInstall() {
      notifications.stop();
      windowManager?.flushState();
      settings.flush();
      await logger.flush();
      await bootstrap?.stop();
    },
    async recoverAfterInstallFailure() {
      await bootstrap?.restartRuntime();
      notifications.start();
    },
    setAllowQuit(value) {
      allowQuit = value;
    }
  });
  queueDeepLink(findDeepLink(process.argv));
  const importSource = runtimeImportSource(
    process.argv,
    process.env.CLAWEE_IMPORT_DATA_DIR
  );
  migrationTask = startRuntimeDataImport({
    source: importSource,
    target: dataDir
  });
  if (importSource !== undefined && importSource.trim().length > 0) {
    bootstrap.markMigratingData();
  }
  try {
    const imported = await migrationTask.result;
    if (imported.imported) {
      settings.update({ importedRuntimeSource: imported.source });
      logger.info('Imported existing Runtime data', {
        source: imported.source,
        target: imported.target
      });
    }
  } catch (error) {
    logger.error('Runtime data import failed', {
      source: importSource,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  void bootstrap.start();

  app.on('activate', () => windowManager?.show());
  app.on('window-all-closed', () => {
    // The tray and Runtime intentionally remain active.
  });
  app.on('before-quit', event => {
    if (allowQuit) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    windowManager?.beginQuit();
    notifications.stop();
    updater.dispose();
    tray.destroy();
    void Promise.all([
      bootstrap?.stop() ?? Promise.resolve(),
      migrationTask?.cancel() ?? Promise.resolve()
    ])
      .catch(error => {
        logger.error('Desktop shutdown failed', {
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        void logger.flush().finally(() => {
          allowQuit = true;
          app.quit();
        });
      });
  });
}

function registerIpcHandlers(input: {
  development: boolean;
  allowInsecureExternalUrls: boolean;
  externalUrlOpener?(url: string): Promise<void>;
  bootstrap: BootstrapController;
  daemon: DaemonManager;
  notifications: NotificationManager;
  windowManager: WindowManager;
  settings: ReturnType<typeof createSettingsStore>;
  dataDir: string;
  logDir: string;
  quit(): void;
  reloadWorkspace(): Promise<void>;
}): void {
  handle(desktopIpc.readConnection, input.development, () =>
    input.bootstrap.rendererConnection());
  handle(desktopIpc.readBootstrap, input.development, () =>
    input.bootstrap.currentState);
  handle(desktopIpc.bootstrapRetry, input.development, async () => {
    await input.daemon.stop();
    await input.bootstrap.start();
    return ok();
  });
  handle(desktopIpc.selectProjectDirectory, input.development, async (_event, purpose: unknown) => {
    const createProject = purpose === 'create';
    const result = await dialog.showOpenDialog({
      title: createProject ? '选择源文件夹' : '添加项目文件夹',
      buttonLabel: createProject ? '添加文件夹' : '添加项目',
      properties: ['openDirectory']
    });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });
  handle(desktopIpc.restartRuntime, input.development, async () => {
    await input.bootstrap.restartRuntime();
    return ok();
  });
  handle(desktopIpc.reloadWorkspace, input.development, async () => {
    await input.reloadWorkspace();
    return input.bootstrap.currentState.phase === 'ready'
      ? ok()
      : failed(input.bootstrap.currentState.error?.message ?? '工作台加载失败');
  });
  handle(desktopIpc.readPreferences, input.development, () => ({
    closeBehavior: input.settings.read().closeBehavior
  }));
  handle(desktopIpc.updatePreferences, input.development, (_event, value: unknown) => {
    if (
      !isRecord(value)
      || (
        value.closeBehavior !== undefined
        && value.closeBehavior !== 'hide'
        && value.closeBehavior !== 'quit'
      )
    ) {
      throw new Error('Desktop preferences are invalid');
    }
    const updated = input.settings.update({
      ...(value.closeBehavior === undefined
        ? {}
        : { closeBehavior: value.closeBehavior })
    });
    return { closeBehavior: updated.closeBehavior };
  });
  handle(desktopIpc.openExternal, input.development, async (_event, url: unknown) => {
    if (typeof url !== 'string') throw new Error('URL must be a string');
    await openExternal(url, {
      allowInsecureHttp: input.allowInsecureExternalUrls,
      ...(input.externalUrlOpener === undefined
        ? {}
        : { opener: input.externalUrlOpener })
    });
  });
  handle(desktopIpc.revealPath, input.development, async (_event, path: unknown) => {
    if (typeof path !== 'string') return failed('路径必须是字符串');
    return await revealPath(path);
  });
  handle(desktopIpc.notify, input.development, (_event, message: unknown) => {
    const parsed = parseNotification(message);
    if (parsed === undefined) throw new Error('Invalid notification payload');
    input.notifications.show(parsed);
  });
  handle(desktopIpc.configureNotifications, input.development, (_event, configuration: unknown) => {
    if (!isRecord(configuration) || typeof configuration.enabled !== 'boolean') {
      return failed('通知配置无效');
    }
    input.notifications.configure(configuration.enabled);
    return ok();
  });
  handle(desktopIpc.exportDiagnostics, input.development, () =>
    exportDesktopDiagnostics({
      state: input.bootstrap.currentState,
      dataDir: input.dataDir,
      logDir: input.logDir,
      daemonPid: input.daemon.pid
    }));
  handle(desktopIpc.quit, input.development, () => input.quit());
}

async function openEnterpriseE2EExternalUrl(url: string): Promise<void> {
  const target = new URL(url);
  const requestUrl = target.hostname === 'recharge.clawee.test'
    ? enterpriseE2ERechargeCallback(target)
    : target;
  const response = await fetch(requestUrl, { redirect: 'follow' });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`Enterprise E2E browser request failed: ${response.status}`);
  }
}

function enterpriseE2ERechargeCallback(target: URL): URL {
  const value = target.searchParams.get('e2e_callback');
  if (value === null) throw new Error('Enterprise E2E recharge callback is missing');
  const callback = new URL(value);
  if (
    callback.protocol !== 'http:'
    || callback.hostname !== '127.0.0.1'
    || callback.pathname !== '/e2e/recharge-opened'
    || callback.username.length > 0
    || callback.password.length > 0
  ) {
    throw new Error('Enterprise E2E recharge callback is invalid');
  }
  return callback;
}

function registerWorkspaceReadyListener(input: {
  development: boolean;
  windowManager: WindowManager;
  ignoreFirstReady: boolean;
}): void {
  let ignoreNext = input.ignoreFirstReady;
  ipcMain.removeAllListeners(desktopIpc.workspaceReady);
  ipcMain.on(desktopIpc.workspaceReady, (event: IpcMainEvent) => {
    assertTrustedWorkspaceSender(event, input.development);
    if (ignoreNext) {
      ignoreNext = false;
      return;
    }
    input.windowManager.confirmWorkspaceReady(
      event.sender.id,
      event.senderFrame?.url ?? ''
    );
  });
}

function handle(
  channel: string,
  development: boolean,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event, development);
    return handler(event, ...args);
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent, development: boolean): void {
  const value = event.senderFrame?.url ?? '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('IPC sender URL is invalid');
  }
  if (
    url.protocol === 'clawee-app:'
    && (url.hostname === 'app' || url.hostname === 'bootstrap')
  ) {
    return;
  }
  if (
    development
    && isDevelopmentWebUrl(url)
  ) {
    return;
  }
  throw new Error(`IPC sender is not trusted: ${value}`);
}

function assertTrustedWorkspaceSender(
  event: IpcMainEvent,
  development: boolean
): void {
  const value = event.senderFrame?.url ?? '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Workspace IPC sender URL is invalid');
  }
  if (url.protocol === 'clawee-app:' && url.hostname === 'app') return;
  if (
    development
    && isDevelopmentWebUrl(url)
  ) {
    return;
  }
  throw new Error(`Workspace IPC sender is not trusted: ${value}`);
}

function parseNotification(value: unknown): DesktopHostNotification | undefined {
  if (
    !isRecord(value)
    || typeof value.title !== 'string'
    || typeof value.body !== 'string'
  ) {
    return undefined;
  }
  return {
    title: value.title,
    body: value.body,
    ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
    ...(typeof value.approvalId === 'string' ? { approvalId: value.approvalId } : {})
  };
}

function registerApplicationProtocol(
  development: boolean,
  appRoot: string,
  logger: ReturnType<typeof createDesktopLogger>
): void {
  const result = development
    ? app.setAsDefaultProtocolClient('clawee', process.execPath, [appRoot])
    : app.setAsDefaultProtocolClient('clawee');
  if (!result) logger.warn('Failed to register clawee:// protocol');
}

function runtimeImportSource(argv: string[], environmentValue?: string): string | undefined {
  const argument = argv.find(value => value.startsWith('--import-runtime='));
  if (argument !== undefined) return argument.slice('--import-runtime='.length);
  return environmentValue;
}

function ok(): DesktopHostResult {
  return { ok: true };
}

function failed(message: string): DesktopHostResult {
  return { ok: false, code: 'FAILED', message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
