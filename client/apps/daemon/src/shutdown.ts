import { UPDATE_DAEMON_CLEANUP_MS } from '@clawee/protocol';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

type SignalSource = {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
};

export function installParentPortShutdown(input: {
  parentPort?: {
    on(event: 'message', listener: (event: unknown) => void): unknown;
    off(event: 'message', listener: (event: unknown) => void): unknown;
    postMessage?(message: unknown): void;
  };
  close(): Promise<void>;
  onError(error: unknown): void;
  finish(): void;
  onShutdown?(reason: string): void;
}): () => void {
  if (input.parentPort === undefined) return () => undefined;
  let closing = false;
  let finished = false;
  let lastHeartbeat = Date.now();
  let lastCheck = lastHeartbeat;
  let confirmationStartedAt: number | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(watchdog);
    clearTimeout(deadline);
    input.finish();
  };
  const shutdown = (reason: string, requestId?: string) => {
    if (closing) return;
    closing = true;
    clearInterval(watchdog);
    input.onShutdown?.(reason);
    deadline = setTimeout(() => {
      input.onError(new Error('DAEMON_SHUTDOWN_TIMEOUT'));
      if (requestId) input.parentPort?.postMessage?.({ type: 'shutdown-complete', requestId, ok: false, code: 'DAEMON_SHUTDOWN_TIMEOUT' });
      finish();
    }, requestId ? UPDATE_DAEMON_CLEANUP_MS : 5_000);
    void input.close().then(() => {
      if (!finished && requestId) input.parentPort?.postMessage?.({ type: 'shutdown-complete', requestId, ok: true });
    }, error => {
      if (finished) return;
      input.onError(error);
      if (requestId) input.parentPort?.postMessage?.({ type: 'shutdown-complete', requestId, ok: false, code: 'DAEMON_CLOSE_FAILED' });
    }).finally(finish);
  };
  const watchdog = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastCheck;
    lastCheck = now;
    // 休眠或时钟调整后先等待新心跳，避免定时器先于积压的 IPC 消息执行。
    if (elapsed < 0 || elapsed >= 5_000) {
      lastHeartbeat = now;
      confirmationStartedAt = undefined;
      return;
    }
    if (now - lastHeartbeat < 10_000) return;
    if (confirmationStartedAt === undefined) {
      confirmationStartedAt = now;
      try { input.parentPort?.postMessage?.({ type: 'parent-heartbeat-request' }); } catch { /* 由确认超时完成清理。 */ }
    } else if (now - confirmationStartedAt >= 5_000) {
      shutdown('parent-heartbeat-timeout');
    }
  }, 1_000);
  watchdog.unref();
  const onMessage = (event: unknown) => {
    const payload = typeof event === 'object' && event !== null && 'data' in event
      ? event.data
      : event;
    if (typeof payload !== 'object' || payload === null || !('type' in payload)) return;
    if (payload.type === 'parent-heartbeat') {
      lastHeartbeat = Date.now();
      confirmationStartedAt = undefined;
    }
    if (payload.type === 'shutdown') shutdown('parent-request', 'requestId' in payload && typeof payload.requestId === 'string' ? payload.requestId : undefined);
  };
  input.parentPort.on('message', onMessage);
  return () => {
    clearInterval(watchdog);
    clearTimeout(deadline);
    input.parentPort?.off('message', onMessage);
  };
}
export function installGracefulShutdown(input: {
  close(): Promise<void>;
  onError(error: unknown): void;
  signalSource?: SignalSource;
}): () => void {
  const signalSource = input.signalSource ?? process;
  let closeWork: Promise<void> | undefined;
  const close = () => {
    if (closeWork !== undefined) return;
    const keepAlive = setInterval(() => undefined, 1_000);
    closeWork = input.close()
      .catch(error => {
        input.onError(error);
      })
      .finally(() => {
        clearInterval(keepAlive);
      });
  };

  signalSource.once('SIGINT', close);
  signalSource.once('SIGTERM', close);

  return () => {
    signalSource.off('SIGINT', close);
    signalSource.off('SIGTERM', close);
  };
}
