import { adminApi } from "./api";

type ListResponse<T> = {
  items: T[];
};

type ModelProxyAuditResponse = {
  audit_id: string;
  request_id: string;
  user_id: string;
  user_name_snapshot: string;
  api_key_id: string;
  api_key_fingerprint: string;
  endpoint: string;
  method: string;
  model: string;
  requested_model?: string;
  upstream_model?: string;
  response_model?: string;
  status: string;
  gateway_status: number;
  upstream_status: number;
  error_code: string;
  error_message: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  usage_available: boolean;
  usage_status?: "complete" | "partial" | "unavailable";
  usage_source?: "upstream" | "estimated" | "unavailable";
  request_headers: Record<string, unknown>;
  request_body: Record<string, unknown> | null;
  response_headers: Record<string, unknown>;
  response_body: Record<string, unknown> | null;
  request_bytes: number;
  response_bytes: number;
  response_chunks: number;
  truncated: boolean;
  duration_ms: number;
  created_at: string;
  completed_at?: string | null;
};

type ModelProxyAuditSummaryResponse = {
  user_id: string;
  user_name_snapshot: string;
  model: string;
  request_count: number;
  succeeded_count: number;
  usage_complete_count?: number;
  usage_partial_count?: number;
  usage_unavailable_count?: number;
  usage_coverage_rate?: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  usage_count: number;
  success_rate: number;
};

type ModelProxyAuditPageResponse = ListResponse<ModelProxyAuditResponse> & {
  next_created_at?: string | null;
  next_id?: string;
  meta?: {
    next_created_at?: string | null;
    next_id?: string;
  };
};

export type ModelProxyAuditFilters = {
  limit?: number;
  userId?: string;
  model?: string;
  endpoint?: string;
  status?: string;
  usageStatus?: "complete" | "partial" | "unavailable";
  usageSource?: "upstream" | "estimated" | "unavailable";
  errorOnly?: boolean;
  createdFrom?: string;
  createdTo?: string;
  cursorCreatedAt?: string;
  cursorId?: string;
};

export type ModelProxyAudit = {
  auditId: string;
  requestId: string;
  userId: string;
  userNameSnapshot: string;
  apiKeyId: string;
  apiKeyFingerprint: string;
  endpoint: string;
  method: string;
  model: string;
  requestedModel?: string;
  upstreamModel?: string;
  responseModel?: string;
  status: string;
  gatewayStatus: number;
  upstreamStatus: number;
  errorCode: string;
  errorMessage: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  usageAvailable: boolean;
  usageStatus?: "complete" | "partial" | "unavailable";
  usageSource?: "upstream" | "estimated" | "unavailable";
  requestHeaders: Record<string, unknown>;
  requestBody: Record<string, unknown> | null;
  responseHeaders: Record<string, unknown>;
  responseBody: Record<string, unknown> | null;
  requestBytes: number;
  responseBytes: number;
  responseChunks: number;
  truncated: boolean;
  durationMs: number;
  createdAt: string;
  completedAt?: string | null;
};

export type ModelProxyAuditSummary = {
  userId: string;
  userNameSnapshot: string;
  model: string;
  requestCount: number;
  succeededCount: number;
  usageCompleteCount?: number;
  usagePartialCount?: number;
  usageUnavailableCount?: number;
  usageCoverageRate?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  usageCount: number;
  successRate: number;
};

function queryString(params: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) query.set(key, String(value));
  });
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function mapAudit(audit: ModelProxyAuditResponse): ModelProxyAudit {
  return {
    auditId: audit.audit_id,
    requestId: audit.request_id,
    userId: audit.user_id,
    userNameSnapshot: audit.user_name_snapshot,
    apiKeyId: audit.api_key_id,
    apiKeyFingerprint: audit.api_key_fingerprint,
    endpoint: audit.endpoint,
    method: audit.method,
    model: audit.model,
    requestedModel: audit.requested_model,
    upstreamModel: audit.upstream_model,
    responseModel: audit.response_model,
    status: audit.status,
    gatewayStatus: audit.gateway_status,
    upstreamStatus: audit.upstream_status,
    errorCode: audit.error_code,
    errorMessage: audit.error_message,
    inputTokens: audit.input_tokens,
    outputTokens: audit.output_tokens,
    totalTokens: audit.total_tokens,
    cacheReadTokens: audit.cache_read_tokens ?? 0,
    cacheCreationTokens: audit.cache_creation_tokens ?? 0,
    reasoningTokens: audit.reasoning_tokens ?? 0,
    usageAvailable: audit.usage_available,
    usageStatus: audit.usage_status ?? (audit.usage_available ? "complete" : "unavailable"),
    usageSource: audit.usage_source ?? (audit.usage_available ? "upstream" : "unavailable"),
    requestHeaders: audit.request_headers ?? {},
    requestBody: audit.request_body ?? null,
    responseHeaders: audit.response_headers ?? {},
    responseBody: audit.response_body ?? null,
    requestBytes: audit.request_bytes,
    responseBytes: audit.response_bytes,
    responseChunks: audit.response_chunks,
    truncated: audit.truncated,
    durationMs: audit.duration_ms,
    createdAt: audit.created_at,
    completedAt: audit.completed_at ?? null
  };
}

function mapSummary(summary: ModelProxyAuditSummaryResponse): ModelProxyAuditSummary {
  const mapped: ModelProxyAuditSummary = {
    userId: summary.user_id,
    userNameSnapshot: summary.user_name_snapshot,
    model: summary.model,
    requestCount: summary.request_count,
    succeededCount: summary.succeeded_count,
    ...(summary.usage_complete_count === undefined && summary.usage_partial_count === undefined && summary.usage_unavailable_count === undefined
      ? {}
      : {
          usageCompleteCount: summary.usage_complete_count ?? summary.usage_count,
          usagePartialCount: summary.usage_partial_count ?? 0,
          usageUnavailableCount: summary.usage_unavailable_count ?? Math.max(0, summary.request_count - summary.usage_count),
          usageCoverageRate: summary.usage_coverage_rate ?? (summary.request_count ? summary.usage_count / summary.request_count : 0)
        }),
    inputTokens: summary.input_tokens,
    outputTokens: summary.output_tokens,
    totalTokens: summary.total_tokens,
    usageCount: summary.usage_count,
    successRate: summary.success_rate
  };
  if (summary.cache_read_tokens !== undefined) mapped.cacheReadTokens = summary.cache_read_tokens;
  if (summary.cache_creation_tokens !== undefined) mapped.cacheCreationTokens = summary.cache_creation_tokens;
  if (summary.reasoning_tokens !== undefined) mapped.reasoningTokens = summary.reasoning_tokens;
  return mapped;
}

export async function listModelProxyAudits(filters: ModelProxyAuditFilters = {}) {
  const response = await adminApi.get<ModelProxyAuditPageResponse>(
    `/model-proxy/audits${queryString({
      limit: filters.limit,
      user_id: filters.userId,
      model: filters.model,
      endpoint: filters.endpoint,
      status: filters.status,
      usage_status: filters.usageStatus,
      usage_source: filters.usageSource,
      error_only: filters.errorOnly,
      created_from: filters.createdFrom,
      created_to: filters.createdTo,
      cursor_created_at: filters.cursorCreatedAt,
      cursor_id: filters.cursorId
    })}`
  );
  return {
    items: response.items.map(mapAudit),
    nextCreatedAt: response.next_created_at ?? response.meta?.next_created_at ?? null,
    nextId: response.next_id ?? response.meta?.next_id ?? ""
  };
}

export async function getModelProxyAudit(auditId: string) {
  const response = await adminApi.get<ModelProxyAuditResponse>(
    `/model-proxy/audits/detail?audit_id=${encodeURIComponent(auditId)}`
  );
  return mapAudit(response);
}

export async function summarizeModelProxyAudits(filters: Omit<ModelProxyAuditFilters, "limit" | "cursorCreatedAt" | "cursorId"> = {}) {
  const response = await adminApi.get<ListResponse<ModelProxyAuditSummaryResponse>>(
    `/model-proxy/audits/summary${queryString({
      user_id: filters.userId,
      model: filters.model,
      endpoint: filters.endpoint,
      status: filters.status,
      usage_status: filters.usageStatus,
      usage_source: filters.usageSource,
      error_only: filters.errorOnly,
      created_from: filters.createdFrom,
      created_to: filters.createdTo
    })}`
  );
  return response.items.map(mapSummary);
}
