type ShutdownSignal = 'SIGINT' | 'SIGTERM';

type SignalSource = {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
};

export function installParentPortShutdown(input: {
  parentPort?: {
    on(event: 'message', listener: (event: unknown) => void): unknown;
  };
  close(): Promise<void>;
  onError(error: unknown): void;
  finish(): void;
}): void {
  let closing = false;
  input.parentPort?.on('message', event => {
    const payload = typeof event === 'object' && event !== null && 'data' in event
      ? event.data
      : event;
    if (
      typeof payload !== 'object' || payload === null
      || !('type' in payload) || payload.type !== 'shutdown' || closing
    ) return;
    closing = true;
    const keepAlive = setInterval(() => undefined, 1_000);
    void input.close()
      .catch(input.onError)
      .finally(() => {
        clearInterval(keepAlive);
        input.finish();
      });
  });
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
