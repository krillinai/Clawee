import { ApiClientError } from './errors.js';
import { incidentErrorDiagnostics, safeIncidentIdentifier } from '@clawee/protocol';
import type { ApiErrorPayload, ConnectionConfig } from './types.js';
import { isRecord } from './validators.js';
import { createWebIncidentObserver } from '../services/incident-observer.js';

export { ApiClientError };

function requestDiagnostics(method: string, path: string) {
  try { return { request_method: method, request_path: new URL(path, 'http://localhost').pathname.slice(0, 512) }; }
  catch { return { request_method: method }; }
}

export type RuntimeClientInput = ConnectionConfig & {
  fetchImpl?: typeof fetch;
};

export type RuntimeRequestOptions = {
  signal?: AbortSignal;
};

export class RuntimeClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private feedbackThreadId?: string;
  private diagnosticCount = 0;
  private incidentObserver = createWebIncidentObserver();
  private incidentObservationDisposed = false;
  private readonly connectionListeners = new Set<(available: boolean) => void>();

  subscribeConnectionStatus(listener: (available: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => { this.connectionListeners.delete(listener); };
  }

  disposeIncidentObservation(): void {
    this.incidentObservationDisposed = true;
    this.incidentObserver.dispose();
    this.connectionListeners.clear();
  }

  activateIncidentObservation(): void {
    if (!this.incidentObservationDisposed) return;
    this.incidentObservationDisposed = false;
    this.incidentObserver = createWebIncidentObserver();
  }

  setFeedbackThread(threadId?: string) { this.feedbackThreadId = threadId; this.diagnosticCount = 0; }
  recordFeedbackError(errorCode: 'network_failed' | 'http_failed' | 'browser_error' | 'unhandled_rejection', method?: string, status?: number) {
    if (!this.feedbackThreadId || this.diagnosticCount++ >= 100) return;
    void this.post('/feedback/diagnostics', { thread_id: this.feedbackThreadId, source: 'web', error_code: errorCode, method, status }).catch(() => {});
  }

  constructor(input: RuntimeClientInput) {
    this.baseUrl = input.baseUrl.replace(/\/+$/, '');
    this.token = input.token;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async get<T = unknown>(
    path: string,
    options: RuntimeRequestOptions = {}
  ): Promise<T> {
    return this.request<T>(path, { method: 'GET', ...options });
  }

  async rawGet(
    path: string,
    options: RuntimeRequestOptions = {}
  ): Promise<Response> {
    return this.rawRequest(path, { method: 'GET', ...options });
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  async postBinary<T = unknown>(
    path: string,
    body: BodyInit,
    contentType = 'application/octet-stream'
  ): Promise<T> {
    const startedAt = Date.now();
    const observer = this.incidentObserver;
    const response = await this.rawRequest(path, {
      method: 'POST',
      binaryBody: body,
      binaryContentType: contentType
    });
    return await this.readResponse<T>(path, 'POST', response, startedAt, undefined, observer);
  }

  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  async request<T>(
    path: string,
    input: {
      method: string;
      body?: unknown;
      signal?: AbortSignal;
    }
  ): Promise<T> {
    const startedAt = Date.now();
    const observer = this.incidentObserver;
    const response = await this.rawRequest(path, input);
    return await this.readResponse<T>(path, input.method, response, startedAt, input.signal, observer);
  }

  private async readResponse<T>(path: string, method: string, response: Response, startedAt: number, signal?: AbortSignal, observer = this.incidentObserver): Promise<T> {
    try {
      const payload = await readSuccessfulJson(response);
      if (!path.startsWith('/feedback')) observer.report({ event_type: 'recovered', stage: 'request', error_code: 'WEB_REQUEST_FAILED' }, `${method}:${path}`);
      return payload as T;
    } catch (error) {
      if (!(error instanceof ApiClientError)) this.observeRequestFailure(path, method, error, startedAt, signal, observer);
      throw error;
    }
  }

  private observeRequestFailure(path: string, method: string, error: unknown, startedAt: number, signal?: AbortSignal, observer = this.incidentObserver): void {
    const timedOut = (error instanceof Error && error.name === 'TimeoutError') || signal?.reason?.name === 'TimeoutError';
    if (path.startsWith('/feedback') || (!timedOut && (signal?.aborted || (error instanceof Error && error.name === 'AbortError')))) return;
    this.recordFeedbackError('network_failed', method);
    observer.report({ event_type: 'error', stage: 'request', error_code: timedOut ? 'WEB_REQUEST_TIMEOUT' : 'WEB_REQUEST_FAILED', duration_ms: Math.max(0, Date.now() - startedAt),
      diagnostics: { ...incidentErrorDiagnostics(error), ...requestDiagnostics(method, path) } }, `${method}:${path}`);
    if (observer === this.incidentObserver) for (const listener of this.connectionListeners) listener(false);
  }

  async rawRequest(
    path: string,
    input: {
      method: string;
      body?: unknown;
      binaryBody?: BodyInit;
      binaryContentType?: string;
      signal?: AbortSignal;
    }
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (path !== '/healthz' && this.token !== undefined && this.token.length > 0) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';
    if (input.binaryBody !== undefined && !(input.binaryBody instanceof FormData)) {
      headers['Content-Type'] =
        input.binaryContentType ?? 'application/octet-stream';
    }

    const startedAt = Date.now();
    const observer = this.incidentObserver;
    let response: Response;
    try { response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: input.method,
      headers,
      signal: input.signal,
      body: input.binaryBody ?? (
        input.body === undefined ? undefined : JSON.stringify(input.body)
      )
    }); } catch (error) {
      this.observeRequestFailure(path, input.method, error, startedAt, input.signal, observer);
      throw error;
    }

    if (!path.startsWith('/feedback') && observer === this.incidentObserver) for (const listener of this.connectionListeners) listener(true);

    if (!response.ok) {
      if (!path.startsWith('/feedback')) this.recordFeedbackError('http_failed', input.method, response.status);
      const payload = await readErrorPayload(response);
      const error = parseApiError(payload);
      const failure = new ApiClientError({
        status: response.status,
        code: error.error.code,
        message: error.error.message,
        details: error.error.details
      });
      const requestId = safeIncidentIdentifier(failure.details?.requestId) ?? safeIncidentIdentifier(response.headers.get('X-Request-ID'));
      if (!path.startsWith('/feedback') && response.status >= 500) observer.report({ event_type: 'error', stage: 'request', error_code: 'WEB_HTTP_FAILED', http_status: response.status, duration_ms: Math.max(0, Date.now() - startedAt),
        diagnostics: { ...incidentErrorDiagnostics(failure), ...requestDiagnostics(input.method, path), ...(requestId ? { request_id: requestId } : {}) } }, `${input.method}:${path}`);
      throw failure;
    }
    return response;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  return JSON.parse(text) as unknown;
}

async function readSuccessfulJson(response: Response): Promise<unknown> {
  const payload = await readJson(response);
  if (!isApiErrorPayload(payload)) return payload;
  const error = parseApiError(payload);
  throw new ApiClientError({
    status: response.status >= 400 ? response.status : 500,
    code: error.error.code,
    message: error.error.message,
    details: error.error.details
  });
}

function isApiErrorPayload(payload: unknown): boolean {
  return (
    isRecord(payload)
    && isRecord(payload.error)
    && typeof payload.error.code === 'string'
  );
}

function parseApiError(payload: unknown): ApiErrorPayload {
  if (!isRecord(payload)) {
    return { error: { code: 'HTTP_ERROR', message: 'Runtime request failed' } };
  }
  if (!isRecord(payload.error)) {
    const code = typeof payload.code === 'string' ? payload.code : 'HTTP_ERROR';
    const message = typeof payload.message === 'string'
      ? payload.message
      : 'Runtime request failed';
    return { error: { code, message } };
  }
  const code = typeof payload.error.code === 'string' ? payload.error.code : 'HTTP_ERROR';
  const message = typeof payload.error.message === 'string' ? payload.error.message : 'Runtime request failed';
  const details = isRecord(payload.error.details) ? payload.error.details : undefined;
  return { error: { code, message, details } };
}

async function readErrorPayload(response: Response): Promise<unknown> {
  try {
    return await readJson(response);
  } catch {
    return {};
  }
}
