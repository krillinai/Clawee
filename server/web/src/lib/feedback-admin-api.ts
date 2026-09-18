import { adminApi } from './api';

export type FeedbackArtifact = { artifact_id: string; kind: string; name: string; size_bytes: number; content_type: string; record_count: number; source: string; upload_state: string };
export type FeedbackReport = { report_id: string; display_number: string; description?: string; reproduction_steps?: string; source_claim?: { customer_label?: string }; trusted_source?: string; environment: Record<string, string>; manifest?: { missing_items: string[]; warnings: string[] }; artifacts?: FeedbackArtifact[]; events?: unknown[]; created_at: string; expires_at: string; completeness: string; processing_status: string; upload_state: string; security_state: string; assigned_to?: string; resolved_at?: string; version: number };
export type FeedbackPage = { records: Array<{ text: string; artifact_id: string; continuation: boolean; fragment_offset: number }>; next_cursor: string; has_next: boolean };
export const feedbackAdminApi = {
  list: (params: URLSearchParams) => adminApi.get<{ items: FeedbackReport[]; meta: { next_cursor: string; has_next: boolean } }>(`/feedback/reports?${params}`),
  get: (id: string) => adminApi.get<FeedbackReport>(`/feedback/reports/${encodeURIComponent(id)}`),
  read: (id: string, kind: 'conversation' | 'logs', params: URLSearchParams) => adminApi.get<FeedbackPage>(`/feedback/reports/${encodeURIComponent(id)}/${kind}?${params}`),
  operate: (id: string, operation: string, input: Record<string, unknown>) => adminApi.post(`/feedback/reports/${encodeURIComponent(id)}/${operation}`, input),
  image: (id: string, aid: string) => `/api/v1/admin/feedback/reports/${encodeURIComponent(id)}/screenshots/${encodeURIComponent(aid)}`,
  download: (id: string, aid: string) => `/api/v1/admin/feedback/reports/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(aid)}/content`
};
