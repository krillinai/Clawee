const ADMIN_API_BASE_PATH = "/api/v1/admin";
const APP_API_BASE_PATH = "/api/v1/app";
const AUTH_API_BASE_PATH = "/api/v1/auth";

type APIClient = {
  get<T>(path: string, init?: RequestInit): Promise<T>;
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  putForm<T>(path: string, body: FormData, init?: RequestInit): Promise<T>;
  delete(path: string, init?: RequestInit): Promise<void>;
};

export type APIErrorDetail = Record<string, unknown>;

export class APIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details: APIErrorDetail[] = []
  ) {
    super(message);
    this.name = "APIError";
  }
}

function scopedURL(basePath: string, path: string) {
  if (path.startsWith("/api/v1/")) {
    return path;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${basePath}${normalizedPath}`;
}

function createAPIClient(basePath: string): APIClient {
  return {
    get: <T>(path: string, init?: RequestInit) => apiFetch<T>(scopedURL(basePath, path), "GET", undefined, init),
    post: <T>(path: string, body?: unknown, init?: RequestInit) => apiFetch<T>(scopedURL(basePath, path), "POST", body, init),
    patch: <T>(path: string, body?: unknown, init?: RequestInit) => apiFetch<T>(scopedURL(basePath, path), "PATCH", body, init),
    put: <T>(path: string, body?: unknown, init?: RequestInit) => apiFetch<T>(scopedURL(basePath, path), "PUT", body, init),
    putForm: <T>(path: string, body: FormData, init?: RequestInit) => apiFetchForm<T>(scopedURL(basePath, path), "PUT", body, init),
    delete: (path: string, init?: RequestInit) => apiFetch<void>(scopedURL(basePath, path), "DELETE", undefined, init)
  };
}

async function apiFetchForm<T>(url: string, method: string, body: FormData, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    method,
    credentials: "include",
    headers: { Accept: "application/json", ...init?.headers },
    body
  });
  if (!response.ok) {
    throw await responseAPIError(response, `${method} ${url} failed with ${response.status}`);
  }
  return unwrapAPIResponse<T>(await response.json());
}

async function apiFetch<T>(url: string, method: string, body?: unknown, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...init?.headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    throw await responseAPIError(response, `${method} ${url} failed with ${response.status}`);
  }

  if (method === "DELETE" || response.status === 204) {
    return undefined as T;
  }

  return unwrapAPIResponse<T>(await response.json());
}

export function unwrapAPIResponse<T>(body: unknown): T {
  if (!body || typeof body !== "object" || !("data" in body)) {
    return body as T;
  }
  const envelope = body as { data: unknown; meta?: unknown };
  if (Array.isArray(envelope.data)) {
    return { data: envelope.data, items: envelope.data, meta: envelope.meta } as T;
  }
  if (envelope.data && typeof envelope.data === "object") {
    return { ...(envelope.data as Record<string, unknown>), data: envelope.data } as T;
  }
  return envelope.data as T;
}

async function responseAPIError(response: Response, fallback: string) {
  try {
    const body = await response.json();
    if (body && typeof body.error === "string" && body.error.trim()) {
      return new APIError(body.error, response.status, "request_failed");
    }
    if (body?.error && typeof body.error.message === "string" && body.error.message.trim()) {
      const details = Array.isArray(body.error.details)
        ? body.error.details.filter((detail: unknown): detail is APIErrorDetail => Boolean(detail) && typeof detail === "object")
        : [];
      return new APIError(
        body.error.message,
        response.status,
        typeof body.error.code === "string" ? body.error.code : "request_failed",
        details
      );
    }
  } catch {
    // Ignore non-JSON error bodies and keep the protocol-level fallback.
  }
  return new APIError(fallback, response.status, "request_failed");
}

export const adminApi = createAPIClient(ADMIN_API_BASE_PATH);
export const appApi = createAPIClient(APP_API_BASE_PATH);
export const authApi = createAPIClient(AUTH_API_BASE_PATH);
export const publicApi = createAPIClient("");
export const apiGet = adminApi.get;
export const apiPost = adminApi.post;
export const apiDelete = adminApi.delete;
