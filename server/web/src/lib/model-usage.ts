import { appApi } from "./api";

type ModelUsageItemResponse = {
  audit_id: string;
  user_name: string;
  api_key_fingerprint: string;
  endpoint: string;
  method: string;
  model: string;
  requested_model?: string;
  upstream_model?: string;
  response_model?: string;
  request_type: string;
  status: string;
  gateway_status: number;
  upstream_status: number;
  error_code: string;
  error_message: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  usage_available: boolean;
  usage_status?: "complete" | "partial" | "unavailable";
  usage_source?: "upstream" | "estimated" | "unavailable";
  request_bytes: number;
  response_bytes: number;
  response_chunks: number;
  truncated: boolean;
  duration_ms: number;
  first_byte_ms: number;
  output_tps: number;
  created_at: string;
  completed_at?: string | null;
};

type ModelUsageSummaryResponse = {
  request_count: number;
  succeeded_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  usage_complete_count?: number;
  usage_partial_count?: number;
  usage_unavailable_count?: number;
  usage_coverage_rate?: number;
  usage_count?: number;
  success_rate: number;
};

type ModelUsageResponse = {
  items: ModelUsageItemResponse[];
  summary: ModelUsageSummaryResponse;
  meta: {
    next_created_at?: string | null;
    next_id?: string;
    has_next: boolean;
  };
};

export type ModelUsageItem = {
  auditId: string;
  userName: string;
  apiKeyFingerprint: string;
  endpoint: string;
  method: string;
  model: string;
  requestedModel?: string;
  upstreamModel?: string;
  responseModel?: string;
  requestType: string;
  status: string;
  gatewayStatus: number;
  upstreamStatus: number;
  errorCode: string;
  errorMessage: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  usageAvailable: boolean;
  usageStatus: "complete" | "partial" | "unavailable";
  usageSource: "upstream" | "estimated" | "unavailable";
  requestBytes: number;
  responseBytes: number;
  responseChunks: number;
  truncated: boolean;
  durationMs: number;
  firstByteMs: number;
  outputTps: number;
  createdAt: string;
  completedAt: string | null;
};

export type ModelUsageSummary = {
  requestCount: number;
  succeededCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  usageCompleteCount: number;
  usagePartialCount: number;
  usageUnavailableCount: number;
  usageCoverageRate: number;
  successRate: number;
};

export type ModelUsage = {
  items: ModelUsageItem[];
  summary: ModelUsageSummary;
  hasNext: boolean;
  nextCreatedAt: string | null;
  nextId: string;
};

export type ModelUsageFilters = {
  limit?: number;
  model?: string;
  createdFrom?: string;
  createdTo?: string;
  cursorCreatedAt?: string;
  cursorId?: string;
};

function queryString(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) query.set(key, String(value));
  });
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export async function getMyModelUsage(filters: ModelUsageFilters = {}): Promise<ModelUsage> {
  const response = await appApi.get<ModelUsageResponse>(`/model-usage${queryString({
    limit: filters.limit,
    model: filters.model,
    created_from: filters.createdFrom,
    created_to: filters.createdTo,
    cursor_created_at: filters.cursorCreatedAt,
    cursor_id: filters.cursorId
  })}`);
  return {
    items: response.items.map((item) => ({
      auditId: item.audit_id,
      userName: item.user_name,
      apiKeyFingerprint: item.api_key_fingerprint,
      endpoint: item.endpoint,
      method: item.method,
      model: item.model,
      requestedModel: item.requested_model,
      upstreamModel: item.upstream_model,
      responseModel: item.response_model,
      requestType: item.request_type,
      status: item.status,
      gatewayStatus: item.gateway_status,
      upstreamStatus: item.upstream_status,
      errorCode: item.error_code,
      errorMessage: item.error_message,
      inputTokens: item.input_tokens,
      outputTokens: item.output_tokens,
      totalTokens: item.total_tokens,
      cacheReadTokens: item.cache_read_tokens,
      cacheCreationTokens: item.cache_creation_tokens ?? 0,
      reasoningTokens: item.reasoning_tokens ?? 0,
      usageAvailable: item.usage_available,
      usageStatus: item.usage_status ?? (item.usage_available ? "complete" : "unavailable"),
      usageSource: item.usage_source ?? (item.usage_available ? "upstream" : "unavailable"),
      requestBytes: item.request_bytes,
      responseBytes: item.response_bytes,
      responseChunks: item.response_chunks,
      truncated: item.truncated,
      durationMs: item.duration_ms,
      firstByteMs: item.first_byte_ms,
      outputTps: item.output_tps,
      createdAt: item.created_at,
      completedAt: item.completed_at ?? null
    })),
    summary: {
      requestCount: response.summary.request_count,
      succeededCount: response.summary.succeeded_count,
      inputTokens: response.summary.input_tokens,
      outputTokens: response.summary.output_tokens,
      totalTokens: response.summary.total_tokens,
      cacheReadTokens: response.summary.cache_read_tokens,
      cacheCreationTokens: response.summary.cache_creation_tokens ?? 0,
      reasoningTokens: response.summary.reasoning_tokens ?? 0,
      usageCompleteCount: response.summary.usage_complete_count ?? response.summary.usage_count ?? 0,
      usagePartialCount: response.summary.usage_partial_count ?? 0,
      usageUnavailableCount: response.summary.usage_unavailable_count ?? 0,
      usageCoverageRate: response.summary.usage_coverage_rate ?? 0,
      successRate: response.summary.success_rate
    },
    hasNext: response.meta?.has_next ?? false,
    nextCreatedAt: response.meta?.next_created_at ?? null,
    nextId: response.meta?.next_id ?? ""
  };
}
