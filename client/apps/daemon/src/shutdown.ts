type ShutdownSignal = 'SIGINT' | 'SIGTERM';

type SignalSource = {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
};

export function installParentPortShutdown(input: {
  parentPort?: {
    on(event: 'message', listener: (event: unknown) => void): unknown;
    off(event: 'message', listener: (event: unknown) => void): unknown;
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
  let deadline: NodeJS.Timeout | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(watchdog);
    clearTimeout(deadline);
    input.finish();
  };
  const shutdown = (reason: string) => {
    if (closing) return;
    closing = true;
    clearInterval(watchdog);
    input.onShutdown?.(reason);
    deadline = setTimeout(() => {
      input.onError(new Error('DAEMON_SHUTDOWN_TIMEOUT'));
      finish();
    }, 5_000);
    void input.close().catch(input.onError).finally(finish);
  };
  const watchdog = setInterval(() => {
    if (Date.now() - lastHeartbeat >= 10_000) shutdown('parent-heartbeat-timeout');
  }, 1_000);
  watchdog.unref();
  const onMessage = (event: unknown) => {
    const payload = typeof event === 'object' && event !== null && 'data' in event
      ? event.data
      : event;
    if (typeof payload !== 'object' || payload === null || !('type' in payload)) return;
    if (payload.type === 'parent-heartbeat') lastHeartbeat = Date.now();
    if (payload.type === 'shutdown') shutdown('parent-request');
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
