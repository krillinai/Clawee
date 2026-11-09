import { adminApi } from './api';
import { trimInput } from './text';

export type FeedbackArtifact = { artifact_id: string; kind: string; name: string; size_bytes: number; content_type: string; record_count: number; source: string; upload_state: string };
export type IncidentDiagnostics = { error_name?: string; error_message?: string; error_stack?: string; additional_details?: string; cause_code?: string; request_method?: string; request_path?: string; request_id?: string };
export type AutomaticIncident = {
  incident_id: string; installation_id: string; app_session_id: string; revision: number;
  source: string; layer: string; stage: string; error_code: string; message: string; first_message: string;
  first_seen_at: string; last_seen_at: string; occurrence_count: number; outcome: string;
  run_id?: string; thread_id?: string; transport_code?: string; http_status?: number; exit_code?: number;
  exit_signal?: string; upstream_request_id?: string; retry_count?: number; duration_ms?: number; unresponsive_ms?: number; task_outcome?: string;
  environment: Record<string, string | number | boolean | undefined>;
  reporter?: { enterprise_key: string; subject_id?: string; display_name?: string; agent_id?: string };
  diagnostics?: IncidentDiagnostics;
  first_diagnostics?: IncidentDiagnostics;
  timeline?: Array<{ at: string; event_type: string; stage: string; error_code: string; duration_ms?: number; retry_count?: number }>;
  logs_expected?: boolean;
};
export type FeedbackReport = { kind?: 'manual' | 'automatic_incident'; incident?: AutomaticIncident; report_id: string; display_number: string; description?: string; reproduction_steps?: string; source_claim?: { customer_label?: string }; trusted_source?: string; environment: Record<string, string>; manifest?: { missing_items: string[]; warnings: string[] }; artifacts?: FeedbackArtifact[]; events?: unknown[]; created_at: string; expires_at: string; completeness: string; processing_status: string; upload_state: string; security_state: string; assigned_to?: string; resolved_at?: string; version: number };
export type FeedbackPage = { records: Array<{ text: string; artifact_id: string; continuation: boolean; fragment_offset: number }>; next_cursor: string; has_next: boolean };
export const feedbackAdminApi = {
  list: (params: URLSearchParams) => adminApi.get<{ items: FeedbackReport[]; meta: { next_cursor: string; has_next: boolean } }>(`/feedback/reports?${new URLSearchParams(Array.from(params, ([key, value]) => [key, trimInput(value)]))}`),
  get: (id: string) => adminApi.get<FeedbackReport>(`/feedback/reports/${encodeURIComponent(id)}`),
  read: (id: string, kind: 'conversation' | 'logs', params: URLSearchParams) => adminApi.get<FeedbackPage>(`/feedback/reports/${encodeURIComponent(id)}/${kind}?${params}`),
  operate: (id: string, operation: string, input: Record<string, unknown>) => adminApi.post(`/feedback/reports/${encodeURIComponent(id)}/${operation}`, input),
  image: (id: string, aid: string) => `/api/v1/admin/feedback/reports/${encodeURIComponent(id)}/screenshots/${encodeURIComponent(aid)}`,
  download: (id: string, aid: string) => `/api/v1/admin/feedback/reports/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(aid)}/content`
};
