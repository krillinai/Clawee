import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DesktopUpdateConnection, DesktopUpdateState } from '@clawee/protocol';
import type { DesktopHostResult } from '../shared/types.js';
import { DesktopUpdateBusyError } from './customer-update-daemon.js';
import { desktopFetch } from './desktop-fetch.js';
import { CustomerUpdateJournal, type UpdateInstallReceipt, type UpdateRecord } from './customer-update-record.js';
import { CustomerUpdateError, updateErrorCode } from './customer-update-error.js';

export type CustomerUpdatePackage = {
  platform: 'macos' | 'windows';
  arch: 'arm64' | 'x64';
  url: string;
  sha512: string;
  size: number;
};

export type CustomerUpdateRelease = {
  kind: 'customer-desktop-update';
  gateway_url: string;
  version: string;
  notes: string;
  packages: CustomerUpdatePackage[];
  revision: number;
  published_at: string;
};

export type NativeUpdateAdapter = {
  check(feed: string, simulatedVersion?: string): Promise<unknown>;
  download(release: CustomerUpdateRelease, artifact: CustomerUpdatePackage): Promise<void>;
  verify(artifact: CustomerUpdatePackage, final?: boolean): Promise<void>;
  discard?(): Promise<void>;
  install(authorizeQuit: () => void, signal?: AbortSignal): Promise<void>;
  onProgress(listener: (percent: number) => void): void;
};

type UpdateInput = {
  gateway?: string;
  getConnection?(): Promise<DesktopUpdateConnection | null>;
  automatic?: boolean;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  native?: NativeUpdateAdapter;
  readRelease(gateway: string): Promise<unknown>;
  prepare(): Promise<void>;
  stop(updateId?: string, attemptId?: string): Promise<void>;
  recover(): Promise<void>;
  journal?: CustomerUpdateJournal;
  readInstallReceipt?(): UpdateInstallReceipt | undefined;
};

export class CustomerUpdateController extends EventEmitter<{
  state: [DesktopUpdateState];
}> {
  private state: DesktopUpdateState;
  private approved?: CustomerUpdateRelease;
  private downloaded?: CustomerUpdateRelease;
  private work?: Promise<DesktopHostResult>;
  private operation?: 'check' | 'download' | 'install';
  private timer?: NodeJS.Timeout;
  private checkTimer?: NodeJS.Timeout;
  private nextCheckAt = Infinity;
  private checkFailures = 0;
  private quitAuthorized = false;
  private connection?: DesktopUpdateConnection;
  private approvedConnection?: DesktopUpdateConnection;
  private stopped = false;
  private disposed = false;
  private automaticWork?: Promise<void>;
  private started = false;
  private readonly journal: CustomerUpdateJournal;
  private startupPending: UpdateRecord[];
  private nativeRequested = false;
  private attempt?: AbortController;
  private workspaceQuiesced?: { id: string; resolve(): void; reject(error: Error): void };
  private testSession?: { version: string; abort: AbortController; record?: UpdateRecord };
  private testWork?: Promise<DesktopHostResult>;

  constructor(private readonly input: UpdateInput) {
    super();
    this.journal = input.journal ?? new CustomerUpdateJournal();
    this.startupPending = this.journal.reconcileStartup(input.currentVersion, input.readInstallReceipt?.());
    if (input.gateway !== undefined) this.connection = { gateway: input.gateway };
    this.state = {
      supported: (input.gateway !== undefined || input.getConnection !== undefined) && input.native !== undefined
        && supportedTarget(input.platform, input.arch),
      status: this.journal.unavailable ? 'paused' : 'idle',
      ...(this.journal.unavailable ? { error: '本地更新记录不可读，自动更新已暂停，请使用官方安装包修复', errorCode: 'UPDATE_RECORD_INVALID' } : {}),
      currentVersion: input.currentVersion,
      testUnsupportedReason: !supportedTarget(input.platform, input.arch) ? '当前平台或架构没有受支持的原生更新器'
        : !input.native ? '此安装包未提供原生更新能力，请使用正式安装包测试' : undefined,
      test: testResult(this.journal.latestTest()),
      ...(input.automatic ? { automatic: true } : {})
    };
    input.native?.onProgress(percent => {
      if (this.state.status === 'downloading' && Number.isFinite(percent)) {
        this.update({ ...this.state, status: percent >= 100 ? 'verifying' : 'downloading', progress: Math.max(0, Math.min(100, percent)) });
      }
    });
  }

  get currentState(): DesktopUpdateState {
    return structuredClone(this.state);
  }

  get installationPending(): boolean {
    return this.operation === 'install' || this.nativeRequested;
  }

  get canQuitForInstall(): boolean {
    return this.quitAuthorized;
  }

  start(): void {
    if (!this.state.supported || this.started) return;
    this.started = true;
    this.disposed = false;
    if (this.input.automatic) {
      this.checkTimer = setInterval(() => { void this.runAutomaticUpdate(); }, 30_000);
      this.checkTimer.unref();
    }
    void this.checkForUpdates().then(result => {
      if (this.input.automatic && (result.ok || this.approved !== undefined)) return this.runAutomaticUpdate();
    });
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    clearInterval(this.checkTimer);
    this.checkTimer = undefined;
    if (!this.nativeRequested) this.attempt?.abort();
    this.testSession?.abort.abort();
  }

  confirmLocalStartup(ready: boolean): void {
    try {
      for (const record of this.startupPending) this.journal.save({ ...record,
        phase: ready ? 'succeeded' : 'paused', errorCode: ready ? undefined : 'LOCAL_INITIALIZATION_FAILED' });
      const pending = this.startupPending.at(-1);
      if (!ready && pending) this.update({ ...this.state, status: 'paused', version: pending.targetVersion,
        updateId: pending.id, errorCode: 'LOCAL_INITIALIZATION_FAILED', recovery: 'failed', recoveryCode: 'LOCAL_INITIALIZATION_FAILED',
        error: '新版客户端本地初始化未完成，请重新检测、导出诊断或使用官方安装包修复' });
      if (ready) this.startupPending = [];
      this.update({ ...this.state, test: testResult(this.journal.latestTest()) });
    } catch { this.update({ ...this.state, status: 'paused', errorCode: 'UPDATE_RECORD_WRITE_FAILED', error: '无法保存更新启动结果，请使用官方安装包修复' }); }
  }

  testUpdate(simulatedVersion: unknown): Promise<DesktopHostResult> {
    if (!this.state.supported) return Promise.resolve({ ok: false, code: 'UNSUPPORTED', message: this.state.testUnsupportedReason ?? '此安装包不支持客户更新' });
    if (this.disposed || this.work || this.automaticWork || this.testWork || this.nativeRequested) {
      return Promise.resolve({ ok: false, code: 'FAILED', message: '另一更新操作正在进行或原生安装结果待确认' });
    }
    if (typeof simulatedVersion !== 'string' || !stableVersion(simulatedVersion)
      || !newerVersion(this.input.currentVersion, simulatedVersion)) {
      return Promise.resolve({ ok: false, code: 'FAILED', message: '模拟起始版本须为低于实际运行版本的稳定版本，例如 1.0.19' });
    }
    clearInterval(this.timer);
    this.timer = undefined;
    this.approved = undefined;
    this.approvedConnection = undefined;
    this.downloaded = undefined;
    const session: NonNullable<CustomerUpdateController['testSession']> = { version: simulatedVersion, abort: new AbortController() };
    this.testSession = session;
    this.update({ supported: true, currentVersion: this.input.currentVersion, automatic: this.input.automatic,
      gateway: this.connection?.gateway, status: 'checking',
      test: { simulatedVersion, status: 'running' } });
    this.testWork = Promise.resolve().then(() => this.executeTest(session)).finally(() => {
      this.testSession = undefined;
      this.testWork = undefined;
    });
    return this.testWork;
  }

  cancelUpdateTest(): DesktopHostResult {
    if (!this.testSession) return { ok: false, code: 'FAILED', message: '当前没有正在执行的升级测试' };
    if (this.installationPending) return { ok: false, code: 'FAILED', message: '已经开始准备安装，不能取消或再次调用安装器' };
    this.testSession.abort.abort();
    return { ok: true };
  }

  private async executeTest(session: NonNullable<CustomerUpdateController['testSession']>): Promise<DesktopHostResult> {
    let result: DesktopHostResult = { ok: false, code: 'FAILED', message: '升级测试未完成' };
    try {
      session.abort.signal.throwIfAborted();
      result = await this.checkForUpdates(true);
      session.abort.signal.throwIfAborted();
      if (!result.ok) return result;
      if (!this.approved) return result = { ok: false, code: 'FAILED', message: '后台没有可供本次测试的批准版本' };
      this.journal.save({ ...this.record(this.approved), fromVersion: this.input.currentVersion,
        phase: 'ready', test: { simulatedVersion: session.version }, errorCode: undefined, recoveryCode: undefined,
        networkFailures: 0, corruptDownloads: 0, nextRetryAt: 0 });
      result = await this.downloadUpdate(true, true);
      session.abort.signal.throwIfAborted();
      if (!result.ok) return result;
      while (true) {
        if ((this.state.deferredUntil ?? 0) > Date.now()) {
          this.update({ ...this.state, test: { simulatedVersion: session.version, status: 'waiting' } });
          await delay(1_000, undefined, { signal: session.abort.signal });
          continue;
        }
        result = await this.installUpdate(true, true);
        if (result.ok || this.state.status !== 'waiting') return result;
        this.update({ ...this.state, test: { simulatedVersion: session.version, status: 'waiting' } });
        await delay(1_000, undefined, { signal: session.abort.signal });
        session.abort.signal.throwIfAborted();
      }
    } catch (error) {
      result = { ok: false, code: 'FAILED', message: session.abort.signal.aborted ? '升级测试已取消'
        : error instanceof Error ? error.message : '升级测试失败' };
      return result;
    } finally {
      const cancelled = session.abort.signal.aborted && !this.nativeRequested;
      const unsupported = !result.ok && result.code === 'UNSUPPORTED';
      if (session.record && !this.nativeRequested) {
        try {
          const record = this.journal.get(session.record) ?? session.record;
          if (record.test) this.journal.save({ ...record, phase: 'paused', errorCode: cancelled ? 'UPDATE_TEST_CANCELLED' : this.state.errorCode ?? 'UPDATE_TEST_FAILED' });
        } catch { /* 不可写状态仍由现有 journal 门禁阻止继续更新。 */ }
      }
      this.update({ ...this.state,
        ...(this.nativeRequested || unsupported ? {} : { status: this.approved ? 'paused' : 'idle' }),
        test: { simulatedVersion: session.version, status: this.nativeRequested ? 'pending' : cancelled ? 'cancelled' : unsupported ? 'unsupported' : 'failed',
          message: this.nativeRequested ? '已请求原生安装，重启后确认结果' : !result.ok ? result.message : undefined } });
    }
  }

  deferInstall(): DesktopHostResult {
    if (this.installationPending) return { ok: false, code: 'FAILED', message: '已经开始准备重启' };
    this.update({ ...this.state, status: 'waiting', deferredUntil: Date.now() + 60 * 60_000 });
    return { ok: true };
  }

  acknowledgeWorkspace(id: unknown, busy = false): void {
    if (id !== this.workspaceQuiesced?.id) return;
    if (busy) this.workspaceQuiesced?.reject(new DesktopUpdateBusyError('工作台仍有编辑或输入活动，等待空闲后安装'));
    else this.workspaceQuiesced?.resolve();
  }

  waitForWorkspace(id: string): Promise<void> {
    return withDeadline(() => new Promise<void>((resolve, reject) => { this.workspaceQuiesced = { id, resolve, reject }; }), 3_000,
      new CustomerUpdateError('WORKSPACE_QUIESCE_TIMEOUT', '工作台未确认停止订阅，已取消安装'))
      .finally(() => { this.workspaceQuiesced = undefined; });
  }

  checkForUpdates(testing = false): Promise<DesktopHostResult> {
    return this.run('check', async () => {
      const deferredUntil = this.state.deferredUntil;
      this.update({ ...this.state, status: 'checking', error: undefined });
      const release = await this.readRelease();
      if (release === undefined) {
        this.approved = undefined;
        this.downloaded = undefined;
        this.update({ supported: true, currentVersion: this.input.currentVersion, status: 'idle', automatic: this.input.automatic, gateway: this.connection?.gateway });
        return;
      }
      const connection = this.connection!;
      this.approved = release;
      this.approvedConnection = connection;
      if (this.downloaded && !sameRelease(this.downloaded, release)) this.downloaded = undefined;
      const record = this.record(release);
      if (record.phase === 'paused') {
        this.update({ supported: true, currentVersion: this.input.currentVersion, version: release.version, gateway: connection.gateway,
          automatic: this.input.automatic, status: 'paused', updateId: record.id, errorCode: record.errorCode,
          recoveryCode: record.recoveryCode, error: '此更新的自动安装已暂停，请明确重试或使用官方安装包修复' });
        return;
      }
      assertNativeMetadata(await this.checkNative(release), release, this.artifact(release));
      await this.assertConnection(connection);
      const alreadyDownloaded = this.downloaded !== undefined && sameRelease(this.downloaded, release);
      if (alreadyDownloaded) await this.verifyDownloaded(release);
      this.approved = release;
      this.approvedConnection = connection;
      if (!alreadyDownloaded) this.downloaded = undefined;
      this.update({
        supported: true,
        currentVersion: this.input.currentVersion,
        status: alreadyDownloaded ? 'downloaded' : 'available',
        version: release.version,
        notes: release.notes,
        automatic: this.input.automatic,
        gateway: connection.gateway,
        updateId: record.id,
        deferredUntil,
        ...(alreadyDownloaded ? { progress: 100 } : {})
      });
    }, testing);
  }

  downloadUpdate(manual = true, testing = false): Promise<DesktopHostResult> {
    return this.run('download', async () => {
      const release = this.approved;
      if (release === undefined) throw new Error('请先检查客户更新');
      await this.assertCurrent(release);
      const record = this.record(release);
      if (record.phase === 'paused') {
        if (!manual) return;
        this.journal.save({ ...record, phase: 'ready', networkFailures: 0, corruptDownloads: 0, nextRetryAt: 0, errorCode: undefined, recoveryCode: undefined });
      }
      if (this.downloaded !== undefined && sameRelease(this.downloaded, release)) {
        try {
          await this.verifyDownloaded(release);
          this.update({ ...this.state, status: 'downloaded', progress: 100, error: undefined });
          return;
        } catch (error) {
          this.downloaded = undefined;
          throw error;
        }
      }
      assertNativeMetadata(await this.checkNative(release), release, this.artifact(release));
      this.downloaded = undefined;
      this.update({ ...this.state, status: 'downloading', progress: 0, error: undefined });
      await this.input.native!.download(release, this.artifact(release));
      this.update({ ...this.state, status: 'verifying', error: undefined });
      await this.assertCurrent(release);
      this.downloaded = release;
      const downloadedRecord = this.record(release);
      if (downloadedRecord.networkFailures > 0) this.journal.save({ ...downloadedRecord, networkFailures: 0, nextRetryAt: 0, errorCode: undefined });
      this.update({ ...this.state, status: 'downloaded', progress: 100 });
    }, testing);
  }

  installUpdate(manual = true, testing = false): Promise<DesktopHostResult> {
    return this.run('install', async () => {
      const release = this.downloaded;
      if (release === undefined) throw new Error('请先下载并校验客户更新');
      await this.assertCurrent(release);
      let record = this.record(release);
      if (record.phase === 'paused') {
        if (!manual) return;
        record = { ...record, phase: 'ready', errorCode: undefined, recoveryCode: undefined };
        this.journal.save(record);
      }
      await this.verifyDownloaded(release);
      let preparationAttempted = false;
      let gatePrepared = false;
      let nativePreparationStarted = false;
      const attempt = new AbortController();
      const attemptId = randomUUID();
      this.attempt = attempt;
      try {
        record = { ...record, test: this.testSession ? { simulatedVersion: this.testSession.version,
          installReceiptBefore: this.input.readInstallReceipt?.()?.fingerprint } : undefined };
        this.journal.save({ ...record, phase: 'preparing' });
        preparationAttempted = true;
        await this.input.prepare();
        gatePrepared = true;
        record = { ...record, phase: 'preparing', attempts: record.attempts + 1 };
        this.journal.save(record);
        await this.assertCurrent(release);
        this.update({ ...this.state, status: 'installing', error: undefined, attemptId });
        await this.input.stop(record.id, attemptId);
        attempt.signal.throwIfAborted();
        this.stopped = true;
        await withDeadline(async () => {
          await this.assertCurrent(release);
          await this.input.native!.verify(this.artifact(release), true);
        }, 20_000);
        attempt.signal.throwIfAborted();
        nativePreparationStarted = true;
        await this.input.native!.install(() => {
          attempt.signal.throwIfAborted();
          if (this.disposed || this.nativeRequested) throw new CustomerUpdateError('INSTALL_CANCELLED', '此安装请求已失效');
          this.journal.save({ ...record, phase: 'native_requested' });
          this.nativeRequested = true;
          this.quitAuthorized = true;
          this.update({ ...this.state, nativePending: true, recovery: 'pending' });
        }, attempt.signal);
        if (!this.nativeRequested) throw new CustomerUpdateError('NATIVE_HANDOFF_UNCONFIRMED', '原生更新器未确认接管安装');
        this.journal.save({ ...record, phase: 'awaiting_start' });
        this.dispose();
      } catch (error) {
        attempt.abort();
        if (error instanceof DesktopUpdateBusyError) {
          if (gatePrepared) {
            try { await this.input.recover(); }
            catch {
              this.journal.save({ ...record, phase: 'paused', errorCode: 'WORKSPACE_RECOVERY_FAILED' });
              throw new CustomerUpdateError('WORKSPACE_RECOVERY_FAILED', '解除更新门禁失败，请重新打开应用');
            }
          }
          this.journal.save({ ...record, phase: 'ready', attempts: record.attempts - (gatePrepared ? 1 : 0) });
          throw error;
        }
        const code = updateErrorCode(error);
        const retryable = code === 'NETWORK_FAILED' && !nativePreparationStarted;
        try { this.journal.save({ ...record, phase: this.nativeRequested ? 'awaiting_start' : retryable ? 'ready' : 'paused', errorCode: code }); } catch { /* 记录不可写仍必须恢复接管前的工作台。 */ }
        if (!this.nativeRequested) {
          this.quitAuthorized = false;
          this.stopped = false;
          if (preparationAttempted) {
            try {
              await this.input.recover();
              this.update({ ...this.state, recovery: 'restored' });
            } catch (recoveryError) {
              const recoveryCode = updateErrorCode(recoveryError) === 'UPDATE_FAILED' ? 'WORKSPACE_RECOVERY_FAILED' : updateErrorCode(recoveryError);
              try { this.journal.save({ ...record, phase: 'paused', errorCode: code, recoveryCode }); } catch { /* 内存状态仍展示两个错误。 */ }
              this.update({ ...this.state, recovery: 'failed', recoveryCode });
            }
          }
        }
        throw error;
      }
    }, testing);
  }

  runAutomaticUpdate(): Promise<void> {
    if (this.automaticWork !== undefined) return this.automaticWork;
    this.automaticWork = this.automaticUpdate().finally(() => { this.automaticWork = undefined; });
    return this.automaticWork;
  }

  private async automaticUpdate(): Promise<void> {
    if (!this.state.supported || this.disposed || this.work !== undefined || this.testSession) return;
    try {
      await this.syncConnection();
      if (this.started && Date.now() >= this.nextCheckAt) {
        if (!(await this.checkForUpdates()).ok) return;
      }
      if (this.disposed || this.approved === undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
        return;
      }
      if (this.timer === undefined && this.checkTimer === undefined) {
        this.timer = setInterval(() => { void this.runAutomaticUpdate(); }, 30_000);
        this.timer.unref();
      }
      const record = this.record(this.approved);
      if (record.phase === 'paused') { clearInterval(this.timer); this.timer = undefined; return; }
      if (record.nextRetryAt > Date.now() || (this.state.deferredUntil ?? 0) > Date.now() || this.nativeRequested) return;
      if (this.downloaded === undefined && !(await this.downloadUpdate(false)).ok) return;
      if (!this.disposed) await this.installUpdate(false);
    } catch (error) {
      await this.run('check', async () => { throw error; });
    }
  }

  private async syncConnection(): Promise<DesktopUpdateConnection | undefined> {
    if (this.stopped || this.input.getConnection === undefined) return this.connection;
    const next = await this.input.getConnection() ?? undefined;
    if (next?.gateway !== this.connection?.gateway) {
      if (next !== undefined) {
        const gateway = httpsUrl(next.gateway);
        if (gateway.origin !== next.gateway) throw new Error('当前服务器连接无效');
      }
      this.connection = next;
      this.approved = undefined;
      this.approvedConnection = undefined;
      this.downloaded = undefined;
      this.nextCheckAt = 0;
      clearInterval(this.timer);
      this.timer = undefined;
      this.update({ supported: this.state.supported, currentVersion: this.input.currentVersion, status: 'idle', automatic: this.input.automatic, gateway: next?.gateway });
    }
    return this.connection;
  }

  private async assertConnection(expected: DesktopUpdateConnection): Promise<void> {
    const current = await this.syncConnection();
    if (this.disposed || current?.gateway !== expected.gateway) {
      throw new Error('更新服务器已变化，旧更新已取消');
    }
  }

  private run(operation: 'check' | 'download' | 'install', action: () => Promise<void>, testing = false): Promise<DesktopHostResult> {
    if (this.testSession && !testing) return Promise.resolve({ ok: false, code: 'FAILED', message: '升级测试正在进行，请先取消或等待完成' });
    if (testing && (this.disposed || this.testSession?.abort.signal.aborted)) return Promise.resolve({ ok: false, code: 'FAILED', message: '升级测试已取消' });
    if (!this.state.supported) {
      return Promise.resolve({ ok: false, code: 'UNSUPPORTED', message: '此安装包不支持客户更新' });
    }
    if (this.journal.unavailable) {
      this.update({ ...this.state, status: 'paused', errorCode: 'UPDATE_RECORD_INVALID', error: '本地更新记录不可读，自动更新已暂停' });
      return Promise.resolve({ ok: false, code: 'FAILED', message: this.state.error! });
    }
    if (this.nativeRequested) return Promise.resolve({ ok: false, code: 'FAILED', message: '已请求原生安装，请退出并重新打开应用确认结果' });
    if (this.work !== undefined) {
      if (operation === this.operation || operation === 'check') return this.work;
      return Promise.resolve({ ok: false, code: 'FAILED', message: '另一更新操作正在进行，请稍后重试' });
    }
    this.operation = operation;
    this.work = Promise.resolve().then(action).then((): DesktopHostResult => {
      if (operation === 'check') {
        this.checkFailures = 0;
        this.nextCheckAt = Date.now() + 15 * 60_000;
      }
      return { ok: true };
    })
      .catch(async (error: unknown): Promise<DesktopHostResult> => {
        if (error instanceof DesktopUpdateBusyError && this.downloaded !== undefined) {
          this.update({ ...this.state, status: 'waiting', error: undefined });
          return { ok: false, code: 'FAILED', message: error.message };
        }
        const message = error instanceof Error ? error.message : '客户更新失败，请重试';
        const code = updateErrorCode(error);
        if (operation === 'check') {
          this.checkFailures += 1;
          this.nextCheckAt = Date.now() + retryDelay(this.checkFailures);
        }
        let paused = operation === 'install' || this.journal.unavailable;
        if (this.approved && !this.nativeRequested && !this.journal.unavailable) {
          const record = this.record(this.approved);
          paused = record.phase === 'paused' || code !== 'NETWORK_FAILED';
          if (record.phase !== 'paused') {
            if (code === 'NETWORK_FAILED') {
              const failures = record.networkFailures + 1;
              paused = false;
              this.journal.save({ ...record, networkFailures: failures, phase: 'ready',
                nextRetryAt: Date.now() + retryDelay(failures), errorCode: code });
            } else if (code === 'PACKAGE_CORRUPT' && record.corruptDownloads < 1) {
              await this.input.native!.discard?.();
              this.downloaded = undefined;
              paused = false;
              this.journal.save({ ...record, corruptDownloads: record.corruptDownloads + 1, phase: 'ready', errorCode: code });
            } else this.journal.save({ ...record, phase: 'paused', errorCode: code });
          }
        }
        if (paused) { clearInterval(this.timer); this.timer = undefined; }
        this.update({ ...this.state, status: paused ? 'paused' : 'error', error: message, errorCode: code });
        return { ok: false, code: code === 'UPDATE_TEST_UNSUPPORTED' ? 'UNSUPPORTED' : 'FAILED', message };
      }).catch((error: unknown): DesktopHostResult => {
        const code = updateErrorCode(error);
        try {
          if (this.approved && !this.journal.unavailable) this.journal.save({ ...this.record(this.approved), phase: 'paused', errorCode: code });
        } catch { /* 无法记录时仍禁止本进程继续更新。 */ }
        clearInterval(this.timer); this.timer = undefined;
        const message = '无法保存或清理本地更新资料，自动更新已暂停，请使用官方安装包修复';
        this.update({ ...this.state, status: 'paused', errorCode: code, error: message });
        return { ok: false, code: 'FAILED', message };
      }).finally(() => {
        this.operation = undefined;
        this.work = undefined;
      });
    return this.work;
  }

  private update(state: DesktopUpdateState): void {
    state = { ...state, test: state.test ?? (this.testSession ? this.state.test : testResult(this.journal.latestTest())),
      testUnsupportedReason: this.state.testUnsupportedReason };
    this.state = state;
    this.emit('state', this.currentState);
  }

  private record(release: CustomerUpdateRelease): UpdateRecord {
    const artifact = this.artifact(release);
    let record = this.journal.ensure({ gateway: release.gateway_url, targetVersion: release.version,
      platform: artifact.platform, arch: artifact.arch, sha512: artifact.sha512 }, this.input.currentVersion);
    if (this.testSession && !this.testSession.record) {
      record = { ...record, fromVersion: this.input.currentVersion, test: { simulatedVersion: this.testSession.version },
        phase: record.phase === 'succeeded' ? 'ready' : record.phase };
      this.journal.save(record);
      this.testSession.record = record;
    }
    return record;
  }

  private async verifyDownloaded(release: CustomerUpdateRelease): Promise<void> {
    try {
      await this.input.native!.verify(this.artifact(release));
    } catch (error) {
      this.downloaded = undefined;
      throw error;
    }
  }

  private async readRelease(): Promise<CustomerUpdateRelease | undefined> {
    const connection = await this.syncConnection();
    if (connection === undefined) return undefined;
    const body = await this.input.readRelease(connection.gateway);
    await this.assertConnection(connection);
    if (!isRecord(body) || !('update' in body)) throw new Error('客户更新响应无效');
    if (body.update === null) return undefined;
    const release = validateRelease(body.update, connection.gateway);
    if (this.testSession) {
      this.testSession.abort.signal.throwIfAborted();
      if (newerVersion(this.input.currentVersion, release.version)) throw new CustomerUpdateError('UPDATE_TEST_DOWNGRADE', '后台批准版本低于实际运行版本，不能通过测试执行降级');
      if (release.version === this.input.currentVersion && this.input.platform === 'win32' && !this.input.readInstallReceipt) {
        throw new CustomerUpdateError('UPDATE_TEST_UNSUPPORTED', '当前原生安装器无法确认同版本安装完成，请使用实际更高版本测试');
      }
      if (!newerVersion(release.version, this.testSession.version)) return undefined;
    } else if (!newerVersion(release.version, this.input.currentVersion)) return undefined;
    if (!release.packages.some(artifact => this.matchesTarget(artifact))) return undefined;
    return release;
  }

  private checkNative(release: CustomerUpdateRelease): Promise<unknown> {
    return this.testSession ? this.input.native!.check(this.feed(release), this.testSession.version)
      : this.input.native!.check(this.feed(release));
  }

  private async assertCurrent(release: CustomerUpdateRelease): Promise<void> {
    if (this.approvedConnection === undefined) throw new Error('旧更新授权已失效，请重新检查');
    await this.assertConnection(this.approvedConnection);
    const current = await this.readRelease();
    if (current === undefined || !sameRelease(current, release)) {
      throw new Error('客户更新发布快照已变化，请重新检查并下载');
    }
  }

  private matchesTarget(artifact: CustomerUpdatePackage): boolean {
    return artifact.platform === (this.input.platform === 'darwin' ? 'macos' : 'windows')
      && artifact.arch === this.input.arch;
  }

  private artifact(release: CustomerUpdateRelease): CustomerUpdatePackage {
    const artifact = release.packages.find(value => this.matchesTarget(value));
    if (artifact === undefined) throw new Error('客户更新不包含当前平台');
    return artifact;
  }

  private feed(release: CustomerUpdateRelease): string {
    const artifact = this.artifact(release);
    return `${release.gateway_url}/api/v1/public/client-updates/${release.revision}/${artifact.platform}/${artifact.arch}/`;
  }
}

export function readCustomerUpdateGateway(resourcesPath: string, packaged: boolean): string | undefined {
  if (!packaged) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(join(resourcesPath, 'deployment/customer-update.json'), 'utf8'));
    if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.gateway_url !== 'string') return undefined;
    const url = httpsUrl(value.gateway_url);
    return value.gateway_url === url.origin ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export async function readPublicCustomerRelease(gateway: string): Promise<unknown> {
  const response = await desktopFetch(`${gateway}/api/v1/public/client-updates`, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new CustomerUpdateError(response.status >= 500 || response.status === 429 ? 'NETWORK_FAILED' : 'AUTHORIZATION_FAILED', `客户更新检查失败（${response.status}）`);
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error('客户更新响应过大');
  return JSON.parse(text) as unknown;
}

function retryDelay(failures: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 5));
}

export function assertNativeMetadata(info: unknown, release: CustomerUpdateRelease, artifact: CustomerUpdatePackage): void {
  if (!isRecord(info) || info.version !== release.version || info.releaseNotes !== release.notes
    || !Array.isArray(info.files) || info.files.length !== 1
    || Object.keys(info).some(key => !['version', 'releaseNotes', 'files', 'path', 'sha512', 'releaseDate'].includes(key))) {
    throw new Error('更新 feed 与批准的发布快照不一致');
  }
  const file: unknown = info.files[0];
  if (!isRecord(file) || file.url !== artifact.url || file.sha512 !== artifact.sha512 || file.size !== artifact.size
    || Object.keys(file).some(key => !['url', 'sha512', 'size'].includes(key))
    || (info.path !== undefined && info.path !== artifact.url)
    || (info.sha512 !== undefined && info.sha512 !== artifact.sha512)) {
    throw new Error('更新包 metadata 与批准的发布快照不一致');
  }
}

function validateRelease(value: unknown, gateway: string): CustomerUpdateRelease {
  if (!isRecord(value) || value.kind !== 'customer-desktop-update' || value.gateway_url !== gateway
    || typeof value.version !== 'string' || !stableVersion(value.version)
    || typeof value.notes !== 'string' || value.notes.length > 20_000
    || !Number.isSafeInteger(value.revision) || Number(value.revision) <= 0
    || typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at))
    || !Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > 3
    || Object.keys(value).some(key => !['kind', 'gateway_url', 'version', 'notes', 'packages', 'revision', 'published_at'].includes(key))) {
    throw new Error('客户更新发布快照无效或不属于此 Gateway');
  }
  const targets = new Set<string>();
  const packages = value.packages.map((artifact: unknown): CustomerUpdatePackage => {
    if (!isRecord(artifact) || (artifact.platform !== 'macos' && artifact.platform !== 'windows')
      || (artifact.arch !== 'arm64' && artifact.arch !== 'x64')
      || (artifact.platform === 'windows' && artifact.arch !== 'x64')
      || typeof artifact.url !== 'string' || artifact.url.length > 4096
      || typeof artifact.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(artifact.sha512)
      || Buffer.from(artifact.sha512, 'base64').toString('base64') !== artifact.sha512
      || !Number.isSafeInteger(artifact.size) || Number(artifact.size) <= 0
      || Object.keys(artifact).some(key => !['platform', 'arch', 'url', 'sha512', 'size'].includes(key))) {
      throw new Error('客户更新包信息无效');
    }
    const url = httpsUrl(artifact.url);
    if (!url.pathname.toLowerCase().endsWith(artifact.platform === 'macos' ? '.zip' : '.exe')) {
      throw new Error('客户更新包格式无效');
    }
    const target = `${artifact.platform}/${artifact.arch}`;
    if (targets.has(target)) throw new Error('客户更新平台重复');
    targets.add(target);
    return { platform: artifact.platform, arch: artifact.arch, url: artifact.url, sha512: artifact.sha512, size: Number(artifact.size) };
  });
  return {
    kind: 'customer-desktop-update', gateway_url: gateway, version: value.version,
    notes: value.notes, revision: Number(value.revision), published_at: value.published_at,
    packages: packages.sort((left, right) => `${left.platform}/${left.arch}`.localeCompare(`${right.platform}/${right.arch}`))
  };
}

function sameRelease(left: CustomerUpdateRelease, right: CustomerUpdateRelease): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('客户更新仅允许 HTTPS 地址');
  return url;
}

export function stableVersion(version: string): boolean {
  return version.length <= 64 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    && version.split('.').every(component => Number.isSafeInteger(Number(component)));
}

function testResult(record: UpdateRecord | undefined): DesktopUpdateState['test'] {
  if (!record?.test) return undefined;
  const status = record.phase === 'succeeded' ? 'succeeded'
    : ['native_requested', 'awaiting_start'].includes(record.phase) ? 'pending'
    : record.errorCode === 'UPDATE_TEST_CANCELLED' ? 'cancelled' : 'failed';
  return { simulatedVersion: record.test.simulatedVersion, status,
    message: status === 'succeeded' ? (record.platform === 'macos'
      ? '重启后版本校验通过，本地初始化已完成；此结果不代表真实旧版本迁移验证'
      : '本次安装及本地初始化已确认；此结果不代表真实旧版本迁移验证')
      : record.errorCode === 'UPDATE_TEST_INSTALL_UNCONFIRMED' ? '未确认本次原生安装完成，测试未通过，请使用官方安装包修复'
      : record.errorCode ? `上次升级测试未完成（${record.errorCode}），不会自动重试` : '等待本地启动确认' };
}

function newerVersion(version: string, current: string): boolean {
  if (!stableVersion(current)) throw new Error('当前安装包版本不是稳定版本');
  const left = version.split('.').map(BigInt);
  const right = current.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}

function supportedTarget(platform: NodeJS.Platform, arch: string): boolean {
  return (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
    || (platform === 'win32' && arch === 'x64');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function withDeadline(action: () => Promise<void>, timeoutMs: number,
  error = new CustomerUpdateError('FINAL_CHECK_TIMEOUT', '停机后的更新复核超时，已取消安装')): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([action(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(error), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
