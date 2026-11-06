import { get } from 'node:http';
import type { DaemonConnection } from '../shared/types.js';
import type { DesktopLogger } from './logger.js';

// 使用 Node HTTP 绕过渲染进程和 Chromium 代理连接，以区分服务故障与页面断线。
export function probeDaemonHealth(connection: DaemonConnection, signal: AbortSignal): Promise<boolean> {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(connection.address)) return Promise.resolve(false);
  return new Promise(resolve => {
    const request = get(`${connection.address}/healthz`, { signal }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 8_192) request.destroy();
      });
      response.on('error', () => resolve(false));
      response.on('end', () => {
        try { resolve(response.statusCode === 200 && JSON.parse(body).ok === true); }
        catch { resolve(false); }
      });
    });
    request.on('error', () => resolve(false));
  });
}

export class RuntimeHealthMonitor {
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private work?: Promise<boolean>;
  private failures = 0;
  private paused = true;
  private stopped = false;
  private unavailable = false;
  private publishedConnection?: DaemonConnection;
  private generation = 0;
  private lastProxyRepairAt: number | undefined;

  constructor(private readonly input: {
    connection(): DaemonConnection | undefined;
    hasProcess(): boolean;
    enabled(): boolean;
    recoverMissing(): Promise<void>;
    publish(available: boolean): void;
    logger: Pick<DesktopLogger, 'info' | 'warn'>;
    probe?: typeof probeDaemonHealth;
    probeProxy?(connection: DaemonConnection, signal: AbortSignal): Promise<boolean>;
    repairProxy?(): Promise<void>;
  }) {}

  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    this.failures = 0;
    void (this.work ?? Promise.resolve()).then(() => this.check());
  }

  get available(): boolean { return !this.unavailable; }

  pause(): void {
    this.paused = true;
    this.generation += 1;
    clearTimeout(this.timer);
    this.controller?.abort();
  }

  stop(): void { this.stopped = true; this.pause(); }

  check(): Promise<boolean> {
    if (this.work !== undefined) return this.work;
    if (this.paused || this.stopped) return Promise.resolve(false);
    clearTimeout(this.timer);
    if (!this.input.enabled()) {
      this.timer = setTimeout(() => { void this.check(); }, 15_000);
      this.timer.unref();
      return Promise.resolve(false);
    }
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const work = this.checkInternal(controller.signal, this.generation).catch(() => false).finally(() => {
      clearTimeout(timeout);
      if (this.work !== work) return;
      this.work = undefined;
      this.controller = undefined;
      if (!this.paused && !this.stopped) {
        this.timer = setTimeout(() => { void this.check(); }, this.failures > 0 ? 5_000 : 15_000);
        this.timer.unref();
      }
    });
    this.work = work;
    return work;
  }

  private async checkInternal(signal: AbortSignal, generation: number): Promise<boolean> {
    if (!this.input.hasProcess() && this.input.connection() === undefined) {
      await this.input.recoverMissing();
    }
    if (signal.aborted || this.paused || !this.input.enabled()) return false;
    const connection = this.input.connection();
    const probe = async (read: () => Promise<boolean>) => {
      if (signal.aborted) return false;
      let abort!: () => void;
      const aborted = new Promise<boolean>(resolve => {
        abort = () => resolve(false);
        signal.addEventListener('abort', abort, { once: true });
      });
      try { return await Promise.race([read().catch(() => false), aborted]); }
      finally { signal.removeEventListener('abort', abort); }
    };
    const daemonHealthy = connection !== undefined && await probe(() => (this.input.probe ?? probeDaemonHealth)(connection, signal));
    const proxyHealthy = daemonHealthy && (this.input.probeProxy === undefined
      || await probe(() => this.input.probeProxy!(connection!, signal)));
    const healthy = daemonHealthy && proxyHealthy;
    if (generation !== this.generation || this.paused || !this.input.enabled() || connection !== this.input.connection()) return false;
    if (healthy) {
      this.failures = 0;
      if (this.unavailable || this.publishedConnection !== connection) {
        this.input.logger.info('Runtime health connection restored');
        this.input.publish(true);
      }
      this.unavailable = false;
      this.publishedConnection = connection;
    } else if (++this.failures >= 3 && !this.unavailable) {
      this.unavailable = true;
      this.input.logger.warn('Runtime health checks failed', { failures: this.failures, hasProcess: this.input.hasProcess() });
      // 进程仍在时只标记不可用，不强制终止可能仍在运行的任务。
      this.input.publish(false);
    }
    if (daemonHealthy && !proxyHealthy && this.failures >= 3 && this.input.repairProxy !== undefined
      && (this.lastProxyRepairAt === undefined || Date.now() - this.lastProxyRepairAt >= 60_000)) {
      this.lastProxyRepairAt = Date.now();
      this.input.logger.warn('Runtime proxy connections resetting');
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.input.repairProxy(),
          new Promise<void>(resolve => { timeout = setTimeout(resolve, 3_000); })
        ]);
      } finally { clearTimeout(timeout); }
    }
    return healthy;
  }
}
