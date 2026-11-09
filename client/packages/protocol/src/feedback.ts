import { canonicalize } from 'json-canonicalize';

export const FEEDBACK_POLICY_VERSION = 1;
export type FeedbackPolicy = { enabled: boolean; policy_version: number; expires_at: string };
export function resolveFeedbackOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname === 'enterprise.invalid') return undefined;
    return url.origin;
  } catch { return undefined; }
}
export type DesktopFeedbackSnapshot = { environment: Record<string, string>; records: unknown[]; warnings: string[] };
export type EmergencyFeedbackScreenshot = { content_type: string; data: Uint8Array };
export type FeedbackArtifact = {
  artifact_id: string;
  kind: 'conversation' | 'logs' | 'environment' | 'diagnostics' | 'screenshot' | 'attachments';
  name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  record_count: number;
  source: string;
  part_index: number;
  first_record?: number;
  last_record?: number;
};
export type FeedbackManifest = {
  schema_version: 1;
  collection_scope?: 'basic' | 'diagnostics';
  snapshot_at: string;
  thread_id: string;
  run_ids: string[];
  runtime_thread_ids: string[];
  watermarks: Array<{ run_id?: string; source?: string; max_event_seq?: number; size_bytes?: number; expected_count?: number; exported_count?: number; boundary?: string; source_truncated?: boolean }>;
  completeness: 'complete' | 'partial';
  redaction_policy_version: 1;
  artifacts: FeedbackArtifact[];
  missing_items: string[];
  warnings: string[];
};
export type FeedbackDraftState = 'collecting' | 'awaiting_consent' | 'queued' | 'uploading' | 'submitted' | 'failed' | 'cancelled';
export type FeedbackDraft = {
  local_feedback_id: string;
  thread_id: string;
  description: string;
  preview?: { description: string; reproduction_steps: string; diagnostics: unknown[] };
  state: FeedbackDraftState;
  origin: string;
  manifest?: FeedbackManifest;
  manifest_sha256?: string;
  size_bytes: number;
  screenshots: Array<{ screenshot_id: string; content_type: string; size_bytes: number }>;
  report_id?: string;
  error_code?: string;
  consent_at?: string;
  retry_count: number;
  next_retry_at?: string;
  expires_at: string;
  materials_expires_at?: string;
  external_feedback_allowed: boolean;
  centre_status?: string;
  public_resolution_summary?: string;
};
export function canonicalFeedbackJSON(value: unknown): string {
  return canonicalize(value);
}
