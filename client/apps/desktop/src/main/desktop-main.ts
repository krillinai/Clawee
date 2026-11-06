import { dirname, join, resolve } from 'node:path';
import { release } from 'node:os';
import { safeIncidentIdentifier, UPDATE_DESKTOP_STOP_MS } from '@clawee/protocol';
import { AutoIncidentReporter } from './auto-incidents.js';
import { captureIncidentLogs } from './incident-logs.js';
import { IncidentBootstrapMonitor } from './incident-bootstrap-monitor.js';
import { createDesktopIncidentGate, incidentE2EFetch, readIncidentEnterpriseKey, readIncidentGatewayOrigin } from './desktop-incidents.js';
import {
  app,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron';
import { createWindowsApplicationMenuTemplate } from './application-menu.js';
import { BootstrapController } from './bootstrap-controller.js';
import { CustomerUpdateController, readPublicCustomerRelease } from './customer-update.js';
import { createCustomerNativeUpdater } from './customer-update-native.js';
import { DesktopUpdateBusyError, prepareDesktopUpdate, requestDaemonUpdate } from './customer-update-daemon.js';
import { CustomerUpdateJournal } from './customer-update-record.js';
import { readWindowsInstallReceipt } from './windows-install-state.js';
import { DaemonManager, settlesWithin } from './daemon-manager.js';
import {
  startRuntimeDataImport,
  type RuntimeDataImportTask
} from './data-migration.js';
import {
  deepLinkToRoute,
  findDeepLink
} from './deep-link-manager.js';
import { isDevelopmentWebUrl } from './development-web.js';
import { desktopFetch } from './desktop-fetch.js';
import { exportDesktopDiagnostics } from './diagnostics.js';
import { collectDesktopFeedback, exportEmergencyFeedback } from './feedback.js';
import {
  resolveDesktopEnterpriseLaunchConfig
} from './enterprise-launch-config-2026-07-30.js';
import {
  ENTERPRISE_CONFIG_FILENAME,
  prepareEnterpriseUserConfig,
  readConfiguredUpdateConnection
} from './enterprise-user-config-2026-08-06.js';
import { createDesktopLogger } from './logger.js';
import {
  openExternal,
  openFile,
  revealPath
} from './native-actions.js';
import { NotificationManager } from './notification-manager.js';
import { installProtocolHandler } from './protocol-handler.js';
import { createSettingsStore } from './settings-store.js';
import { TrayManager } from './tray-manager.js';
import { WindowManager } from './window-manager.js';
import { RuntimeHealthMonitor } from './runtime-health.js';
import { desktopIpc } from '../shared/ipc.js';
import type {
  DesktopHostNotification,
  DesktopHostResult
} from '../shared/types.js';

const DEVELOPMENT = !app.isPackaged;
const DESKTOP_SHUTDOWN_TIMEOUT_MS = 5_000;
const SHUTDOWN_LOG_FLUSH_RESERVE_MS = 500;

export async function launchDesktop(appEntryAt: number, earlyLaunchArguments: readonly string[]): Promise<void> {
  const pendingRoutes: string[] = [];
  let windowManager: WindowManager | undefined;
  let bootstrap: BootstrapController | undefined;
  let workspaceLoaded = false;
  let localDataReady = true;
  let dataImportPending = true;
  let updateStopping = false;
  let updateHadConnection = false;
  let workspaceLoadWork: Promise<void> | undefined;
  let shutdownStarted = false;
  let allowQuit = false;
  let migrationTask: RuntimeDataImportTask | undefined;
  let runtimeHealth: RuntimeHealthMonitor | undefined;

  const queueDeepLink = (value: string | undefined) => {
    if (shutdownStarted) return;
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
    if (argv.includes('--updated') && !shutdownStarted && bootstrap?.currentState.phase === 'failed' && !updates.installationPending) {
      void bootstrap.start();
    }
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
  const incidents = new AutoIncidentReporter({
    path: join(userData, 'auto-incidents.json'), logger,
    environment: { app_version: app.getVersion(), electron_version: process.versions.electron, platform: process.platform, arch: process.arch, os_version: release(),
      ...(safeIncidentIdentifier(process.env.CLAWEE_BUILD_SHA) ? { build_sha: process.env.CLAWEE_BUILD_SHA } : {}) },
    enterpriseKey: () => readIncidentEnterpriseKey(enterpriseUserConfig.path),
    gatewayOrigin: () => readIncidentGatewayOrigin(enterpriseUserConfig.path),
    collectLogs: incident => captureIncidentLogs({ logDir, dataDir, incident }),
    fetchImpl: incidentE2EFetch(enterpriseLaunchConfig.enterpriseE2ERunId, process.env.CLAWEE_E2E_INCIDENT_ORIGIN)
  });
  const incidentBootstrap = new IncidentBootstrapMonitor(incidents);
  const incidentGate = createDesktopIncidentGate(observation => incidents.observe(observation));
  daemon.on('incident', observation => incidents.observe(observation));
  daemon.on('incidentIdentity', context => incidents.updateIdentity(context.identity, context.expires_at));
  daemon.on('incidentEnvironment', environment => incidents.updateEnvironment(environment));
  daemon.on('exit', () => incidents.updateIdentity(undefined));
  daemon.on('exit', event => incidentBootstrap.exit(event));
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
    version: app.getVersion(),
    updatedStartup: process.argv.includes('--updated'),
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
    appEntryAt,
    workspaceReadyTimeoutMs: parsePositiveInteger(
      process.env.CLAWEE_E2E_WORKSPACE_READY_TIMEOUT_MS
    ),
    requestQuit: () => app.quit(),
    onActivate: () => { daemon.sendHeartbeat(); void runtimeHealth?.check(); }
  });

  const navigate = (route: string) => {
    if (shutdownStarted) return;
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
  const menu = Menu.getApplicationMenu() ?? Menu.buildFromTemplate(process.platform === 'darwin'
    ? [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }] : []);
  Menu.setApplicationMenu(menu);
  const notifications = new NotificationManager({
    getConnection: () => daemon.currentConnection,
    settings,
    logger,
    navigate
  });
  const updateTransitionTimes = new Map<string, number>();
  const updates = new CustomerUpdateController({
    journal: new CustomerUpdateJournal(join(userData, 'customer-update-state.json'), record => {
      const previousAt = updateTransitionTimes.get(record.id) ?? record.updatedAt;
      updateTransitionTimes.set(record.id, record.updatedAt);
      logger.info('Customer update transition', { updateId: record.id, fromVersion: record.fromVersion,
        targetVersion: record.targetVersion, platform: record.platform, arch: record.arch, phase: record.phase,
        durationMs: Math.max(0, record.updatedAt - previousAt), attempts: record.attempts, errorCode: record.errorCode, recoveryCode: record.recoveryCode,
        simulatedVersion: record.test?.simulatedVersion });
    }),
    getConnection: async () => readConfiguredUpdateConnection(enterpriseUserConfig.path),
    automatic: true,
    currentVersion: app.getVersion(),
    readInstallReceipt: process.platform === 'win32' ? () => readWindowsInstallReceipt(dirname(process.resourcesPath)) : undefined,
    platform: process.platform,
    arch: process.arch,
    native: app.isPackaged ? createCustomerNativeUpdater(process.platform, () => windowManager?.beginQuit(), logger) : undefined,
    readRelease: readPublicCustomerRelease,
    prepare: async () => {
      updateHadConnection = daemon.currentConnection !== undefined;
      await prepareDesktopUpdate({ shutdownStarted, dataImportPending, workspaceLoading: workspaceLoadWork !== undefined,
        workspaceOpen: windowManager?.hasWorkspace === true, daemon });
    },
    stop: async (updateId, attemptId) => {
      if (workspaceLoadWork !== undefined) throw new DesktopUpdateBusyError('等待工作台页面切换结束');
      if (windowManager?.hasWorkspace) await updates.waitForWorkspace(attemptId!);
      updateStopping = true;
      incidentGate.stop();
      incidentBootstrap.stop();
      notifications.stop();
      await bootstrap!.stopForUpdate(UPDATE_DESKTOP_STOP_MS, updateId);
      if (daemon.pid !== undefined || daemon.currentConnection !== undefined) throw new Error('本地运行服务未确认关闭');
    },
    recover: async () => {
      if (shutdownStarted) return;
      updateStopping = false;
      incidentBootstrap.resume();
      try {
        windowManager?.cancelQuit();
        let restart = false;
        try {
          if (daemon.currentConnection !== undefined) await requestDaemonUpdate(daemon.currentConnection, 'cancel');
        } catch {
          restart = true;
        }
        await bootstrap!.resumeAfterUpdate(restart);
        if (updateHadConnection && daemon.currentConnection === undefined) throw new Error('工作台恢复失败，请在启动恢复页重试或使用官方安装包修复');
        if (daemon.currentConnection !== undefined) {
          await requestDaemonUpdate(daemon.currentConnection, 'cancel');
          notifications.start();
        }
      } finally {
        if (!shutdownStarted) incidentGate.resume();
      }
    }
  });
  updates.on('state', state => windowManager?.send(desktopIpc.updateStateChanged, state));
  updates.start();
  const loadWorkspace = (): Promise<void> => {
    if (shutdownStarted || updateStopping) return Promise.resolve();
    if (workspaceLoadWork !== undefined) return workspaceLoadWork;
    workspaceLoadWork = (async () => {
      workspaceLoaded = false;
      try {
        await windowManager?.loadWorkspace();
        if (shutdownStarted) return;
        workspaceLoaded = true;
        bootstrap?.markWorkspaceReady();
        runtimeHealth?.resume();
        windowManager?.show();
        logger.info('Desktop workspace ready', { version: app.getVersion(), durationMs: Date.now() - appEntryAt });
        updates.confirmLocalStartup(localDataReady);
        for (const route of pendingRoutes.splice(0)) {
          windowManager?.send(desktopIpc.navigate, route);
        }
        notifications.start();
      } catch (error) {
        if (shutdownStarted) return;
        logger.error('Failed to load the Clawee workspace', {
          message: error instanceof Error ? error.message : String(error)
        });
        bootstrap?.markWorkspaceFailed(error);
        updates.confirmLocalStartup(false);
        await windowManager?.loadBootstrap();
      }
    })().finally(() => {
      workspaceLoadWork = undefined;
    });
    return workspaceLoadWork;
  };

  runtimeHealth = new RuntimeHealthMonitor({
    connection: () => daemon.currentConnection,
    hasProcess: () => daemon.hasProcess,
    enabled: () => !shutdownStarted && !updates.installationPending
      && ['ready', 'failed', 'workspace_failed'].includes(bootstrap!.currentState.phase),
    recoverMissing: () => incidentGate.restart(() => bootstrap!.recoverConnection()),
    publish: available => windowManager?.send(desktopIpc.connectionChanged, available ? bootstrap!.rendererConnection() : null),
    probeProxy: async (connection, signal) => {
      const response = await desktopFetch(`${connection.address}/healthz`, { signal, redirect: 'error' });
      return response.ok && (await response.json() as { ok?: boolean }).ok === true;
    },
    repairProxy: () => session.defaultSession.closeAllConnections(),
    logger
  });

  await installProtocolHandler({
    webRoot,
    bootstrapRoot,
    getConnection: () => daemon.currentConnection,
    logger
  });
  registerIpcHandlers({
    incidentGate,
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
    logger,
    updates,
    quit: () => app.quit(),
    reloadWorkspace: loadWorkspace,
    runtimeHealth
  });
  registerWorkspaceReadyListener({
    development,
    windowManager,
    ignoreFirstReady:
      process.env.CLAWEE_E2E_IGNORE_FIRST_WORKSPACE_READY === '1'
  });

  bootstrap.on('state', state => {
    if (state.phase === 'failed' || state.phase === 'workspace_failed') updates.confirmLocalStartup(false);
    incidentBootstrap.update(state);
    windowManager?.send(desktopIpc.bootstrapChanged, state);
  });
  bootstrap.on('connection', connection => {
    windowManager?.send(desktopIpc.connectionChanged, connection);
  });
  bootstrap.on('ready', () => {
    if (workspaceLoaded) {
      bootstrap?.markWorkspaceReady();
      runtimeHealth?.resume();
    } else {
      void loadWorkspace();
    }
  });
  powerMonitor.on('suspend', () => runtimeHealth?.pause());
  powerMonitor.on('resume', () => {
    daemon.sendHeartbeat();
    runtimeHealth?.resume();
    void updates.checkForUpdates().then(result => { if (result.ok) void updates.runAutomaticUpdate(); });
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
  if (enterpriseLaunchConfig.enterpriseE2ERunId === undefined) {
    registerApplicationProtocol(development, appRoot, logger);
  }
  queueDeepLink(findDeepLink(process.argv));
  for (const value of earlyLaunchArguments) queueDeepLink(value);
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
    localDataReady = false;
    updates.confirmLocalStartup(false);
    logger.error('Runtime data import failed', {
      source: importSource,
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    dataImportPending = false;
  }
  incidents.start();
  void bootstrap.start();
  runtimeHealth.resume();

  app.on('activate', () => windowManager?.show());
  app.on('before-quit', event => {
    if (updates.canQuitForInstall) {
      runtimeHealth?.stop();
      incidentGate.stop();
      incidentBootstrap.stop(); incidents.dispose();
      updates.dispose();
      windowManager?.beginQuit();
      notifications.stop();
      tray.destroy();
      return;
    }
    if (updates.installationPending) {
      event.preventDefault();
      return;
    }
    if (allowQuit) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    runtimeHealth?.stop();
    incidentGate.stop();
    incidentBootstrap.stop(); incidents.dispose();
    updates.dispose();
    const startedAt = Date.now();
    const deadline = startedAt + DESKTOP_SHUTDOWN_TIMEOUT_MS;
    const cleanupTimeoutMs = DESKTOP_SHUTDOWN_TIMEOUT_MS - SHUTDOWN_LOG_FLUSH_RESERVE_MS;
    logger.info('Desktop shutdown started', { timeoutMs: DESKTOP_SHUTDOWN_TIMEOUT_MS });
    windowManager?.beginQuit();
    notifications.stop();
    tray.destroy();
    void settlesWithin(Promise.allSettled([
      bootstrap?.stop(cleanupTimeoutMs) ?? Promise.resolve(),
      migrationTask?.cancel() ?? Promise.resolve()
    ]).then(results => {
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
    }), cleanupTimeoutMs)
      .then(completed => {
        if (!completed) logger.warn('Desktop shutdown cleanup deadline reached');
      })
      .catch(error => {
        logger.error('Desktop shutdown failed', {
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        const daemonExited = !daemon.hasProcess;
        logger.info('Desktop shutdown cleanup finished', {
          durationMs: Date.now() - startedAt, daemonExited, daemonPid: daemon.pid
        });
        if (!daemonExited) logger.error('Desktop quitting before daemon exit was confirmed', {
          daemonPid: daemon.pid, recovery: 'daemon-parent-heartbeat-watchdog'
        });
        void settlesWithin(logger.flush(), Math.max(0, deadline - Date.now())).finally(() => {
          allowQuit = true;
          app.quit();
        });
      });
  });
}

export function registerIpcHandlers(input: {
  incidentGate: ReturnType<typeof createDesktopIncidentGate>;
  logger: ReturnType<typeof createDesktopLogger>;
  development: boolean;
  allowInsecureExternalUrls: boolean;
  externalUrlOpener?(url: string): Promise<void>;
  bootstrap: BootstrapController;
  updates: CustomerUpdateController;
  daemon: DaemonManager;
  notifications: NotificationManager;
  windowManager: WindowManager;
  settings: ReturnType<typeof createSettingsStore>;
  dataDir: string;
  logDir: string;
  quit(): void;
  reloadWorkspace(): Promise<void>;
  runtimeHealth?: RuntimeHealthMonitor;
}): void {
  handle(desktopIpc.reportIncident, input.development, (event, observation: unknown) => {
    assertTrustedWorkspaceSender(event, input.development);
    input.incidentGate.observe(event, observation);
  });
  handle(desktopIpc.readUpdateState, input.development, () => input.updates.currentState);
  handle(desktopIpc.checkForUpdates, input.development, async () => {
    const result = await input.updates.checkForUpdates();
    if (result.ok) void input.updates.runAutomaticUpdate();
    return result;
  });
  handle(desktopIpc.downloadUpdate, input.development, async () => {
    const result = await input.updates.downloadUpdate();
    if (result.ok) void input.updates.runAutomaticUpdate();
    return result;
  });
  handle(desktopIpc.installUpdate, input.development, () => input.updates.installUpdate());
  handle(desktopIpc.testUpdate, input.development, (event, version: unknown) => {
    assertTrustedWorkspaceSender(event, input.development);
    return input.updates.testUpdate(version);
  });
  handle(desktopIpc.cancelUpdateTest, input.development, event => {
    assertTrustedWorkspaceSender(event, input.development);
    return input.updates.cancelUpdateTest();
  });
  handle(desktopIpc.deferUpdate, input.development, () => input.updates.deferInstall());
  handle(desktopIpc.updateQuiesced, input.development, (event, id, busy) => {
    assertTrustedWorkspaceSender(event, input.development);
    input.updates.acknowledgeWorkspace(id, busy === true);
  });
  handle(desktopIpc.readConnection, input.development, async () => {
    await input.runtimeHealth?.check();
    return input.runtimeHealth?.available === false ? null : input.bootstrap.rendererConnection();
  });
  handle(desktopIpc.readBootstrap, input.development, () =>
    input.bootstrap.currentState);
  handle(desktopIpc.bootstrapRetry, input.development, async () => {
    if (input.updates.installationPending) return failed('更新安装期间不能重新启动 Runtime');
    await input.incidentGate.restart(async () => {
      await input.daemon.stop();
      await input.bootstrap.start();
    });
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
  handle(desktopIpc.selectContextDirectory, input.development, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择参考文件夹',
      buttonLabel: '添加文件夹',
      properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(desktopIpc.restartRuntime, input.development, async () => {
    if (input.updates.installationPending) return failed('更新安装期间不能重新启动 Runtime');
    await input.incidentGate.restart(() => input.bootstrap.restartRuntime());
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
  handle(desktopIpc.openFile, input.development, async (event, path: unknown) => {
    assertTrustedWorkspaceSender(event, input.development);
    if (typeof path !== 'string') return failed('路径必须是字符串');
    return await openFile(path);
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
  handle(desktopIpc.collectFeedback, input.development, (_event, threadId: unknown) => { if (typeof threadId !== 'string') throw new Error('Invalid thread'); return collectDesktopFeedback({ threadId, logDir: input.logDir, logger: input.logger }); });
  handle(desktopIpc.emergencyFeedback, input.development, (_event, description: unknown, screenshots: unknown) => { if (typeof description !== 'string' || (screenshots !== undefined && (!Array.isArray(screenshots) || screenshots.length > 5 || screenshots.some(s => !isRecord(s) || typeof s.content_type !== 'string' || !(s.data instanceof Uint8Array))))) throw new Error('Invalid emergency feedback'); return exportEmergencyFeedback({ description, screenshots: screenshots as import('@clawee/protocol').EmergencyFeedbackScreenshot[] | undefined, logDir: input.logDir, logger: input.logger, state: input.bootstrap.currentState }); });
  handle(desktopIpc.quit, input.development, () => input.quit());
}

async function openEnterpriseE2EExternalUrl(url: string): Promise<void> {
  const target = new URL(url);
  const requestUrl = target.hostname === 'recharge.clawee.test'
    ? enterpriseE2ERechargeCallback(target)
    : target;
  const response = await desktopFetch(requestUrl, { redirect: 'follow' });
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
  event: IpcMainEvent | IpcMainInvokeEvent,
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
