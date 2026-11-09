// 与所有 Runtime 请求共用信号，包括模型和任务 SSE；暂停期间不发起新请求。
export function createUpdateRequestGate(fetchImpl: typeof fetch) {
  let controller = new AbortController();
  let paused = false;
  return {
    fetch: ((input, init) => {
      if (paused) return Promise.reject(new DOMException('工作台正在准备更新', 'AbortError'));
      const existing = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return fetchImpl(input, { ...init, signal: existing ? AbortSignal.any([existing, controller.signal]) : controller.signal });
    }) as typeof fetch,
    pause() { paused = true; controller.abort(); },
    resume() { if (paused) controller = new AbortController(); paused = false; }
  };
}
