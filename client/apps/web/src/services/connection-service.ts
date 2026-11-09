import type {
  CodexStatusResponse,
  ModelAccessState,
  RuntimeHealthResponse
} from '@clawee/protocol';
import { ApiClientError, type RuntimeClient } from '../runtime/client.js';
import { createWebIncidentObserver } from './incident-observer.js';

export type ConnectionState =
  | { status: 'disconnected'; message: string }
  | { status: 'connected'; codexStatus: CodexStatusResponse }
  | {
      status: 'configuration_required';
      configuration: ModelAccessState;
    }
  | { status: 'invalid_token'; message: string };

type ClientLike = Pick<RuntimeClient, 'get'> & Partial<Pick<RuntimeClient, 'subscribeConnectionStatus' | 'disposeIncidentObservation' | 'activateIncidentObservation'>>;

export function createConnectionService(client: ClientLike) {
  let ready = false;
  let disposed = false;
  let generation = 0;
  let reported = false;
  let incidentObserver = createWebIncidentObserver();
  let disconnectedAt: number | undefined;
  let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
  let checkWork: Promise<ConnectionState> | undefined;
  let checkAbort: AbortController | undefined;
  const connected = () => {
    if (disposed) return;
    ready = true; clearTimeout(disconnectedTimer); disconnectedTimer = undefined; disconnectedAt = undefined;
    if (reported) incidentObserver.report({ event_type: 'recovered', stage: 'connection', error_code: 'WEB_DISCONNECTED' });
    reported = false;
  };
  const disconnected = () => {
    if (disposed || !ready || disconnectedAt !== undefined) return;
    disconnectedAt = Date.now();
    disconnectedTimer = setTimeout(() => {
      if (disposed || disconnectedAt === undefined) return;
      reported = true;
      incidentObserver.report({ event_type: 'error', stage: 'connection', error_code: 'WEB_DISCONNECTED', duration_ms: Math.max(0, Date.now() - disconnectedAt) });
    }, 15_000);
  };
  const subscribe = () => client.subscribeConnectionStatus?.(available => {
    if (available) {
      if (ready) connected();
    } else disconnected();
  });
  let unsubscribe = subscribe();
  return {
    activate() {
      if (!disposed) return;
      disposed = false; reported = false;
      incidentObserver = createWebIncidentObserver();
      client.activateIncidentObservation?.();
      unsubscribe = subscribe();
    },
    dispose() {
      disposed = true; generation++; clearTimeout(disconnectedTimer); disconnectedTimer = undefined; disconnectedAt = undefined; ready = false;
      checkAbort?.abort(); checkAbort = undefined; checkWork = undefined;
      unsubscribe?.(); incidentObserver.dispose(); client.disposeIncidentObservation?.();
    },
    check(): Promise<ConnectionState> {
      if (checkWork !== undefined) return checkWork;
      const checkGeneration = ++generation;
      const controller = new AbortController();
      checkAbort = controller;
      const timeout = setTimeout(() => controller.abort(new DOMException('本地服务连接超时', 'TimeoutError')), 5_000);
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      const probe = async (): Promise<ConnectionState> => {
        const health = await client.get<RuntimeHealthResponse>('/healthz', { signal: controller.signal });
        if (controller.signal.aborted) throw controller.signal.reason;
        if (health.runtimeState === 'configuration_required') {
          const configuration =
            await client.get<ModelAccessState>(
              '/runtime/model-service', { signal: controller.signal }
            );
          if (checkGeneration === generation && !controller.signal.aborted) connected();
          return { status: 'configuration_required', configuration };
        }
        const codexStatus = await client.get<CodexStatusResponse>('/codex/status', { signal: controller.signal });
        if (checkGeneration === generation && !controller.signal.aborted) connected();
        return { status: 'connected', codexStatus };
      };
      const work = Promise.race([probe(), aborted]).catch((error): ConnectionState => {
        const message = errorMessage(error);
        if (!(error instanceof ApiClientError) && checkGeneration === generation) disconnected();
        if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
          return { status: 'invalid_token', message };
        }
        return { status: 'disconnected', message };
      }).finally(() => {
        clearTimeout(timeout);
        if (checkWork === work) { checkWork = undefined; checkAbort = undefined; }
      });
      checkWork = work;
      return work;
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? error.message : 'Runtime connection failed';
}
