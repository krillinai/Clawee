import type { CodexAppServerRequestClient } from './app-server-client.js';

export type DeferredCodexAppServerClient =
  CodexAppServerRequestClient & {
    activate(client: CodexAppServerRequestClient): void;
    deactivate(): Promise<void>;
    ready(): boolean;
  };

export function createDeferredCodexAppServerClient():
DeferredCodexAppServerClient {
  let active: CodexAppServerRequestClient | undefined;
  let closed = false;

  return {
    activate(client) {
      if (closed) {
        void client.close();
        throw new Error('Deferred Codex app-server client is closed');
      }
      if (active !== undefined) {
        void client.close();
        throw new Error('Deferred Codex app-server client is already active');
      }
      active = client;
    },
    ready() {
      return active !== undefined;
    },
    async deactivate() {
      const client = active;
      active = undefined;
      await client?.close();
    },
    async request<Result>(method: string, params: unknown): Promise<Result> {
      if (closed) throw new Error('Deferred Codex app-server client is closed');
      if (active === undefined) {
        throw new Error('MODEL_SERVICE_CONFIGURATION_REQUIRED');
      }
      return await active.request<Result>(method, params);
    },
    async close() {
      if (closed) return;
      closed = true;
      const client = active;
      active = undefined;
      await client?.close();
    }
  };
}
