import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeedbackManifest } from '@clawee/protocol';
import { redactFeedback } from './redactor.js';

export type NativeFeedback = { environment: Record<string, string>; records: unknown[]; warnings: string[] };
const statuses = new Set(['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted']);
const errorCodes = new Set(['CODEX_STREAM_ERROR', 'SPAWN_FAILED', 'TIMEOUT', 'INACTIVITY_TIMEOUT', 'CODEX_EXIT_ERROR', 'RUNTIME_UNAVAILABLE', 'network_failed', 'http_failed', 'browser_error', 'unhandled_rejection']);
export function feedbackEnvironment(environment: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['app_version', 'daemon_version', 'runtime_version', 'electron_version']) {
    const value = environment[key];
    if (value && /^[0-9][A-Za-z0-9.+_-]{0,63}$/.test(value)) result[key] = value;
  }
  if (/^[a-f0-9]{7,64}$/.test(environment.build_sha ?? '')) result.build_sha = environment.build_sha!;
  if (['darwin', 'win32', 'linux'].includes(environment.platform ?? '')) result.platform = environment.platform!;
  if (['arm64', 'x64', 'ia32', 'arm'].includes(environment.arch ?? '')) result.arch = environment.arch!;
  return result;
}
export async function collectFeedback(input: { db: Database.Database; dataDir: string; directory: string; threadId: string; environment: Record<string, string>; native?: NativeFeedback; includeDiagnostics?: boolean; signal: AbortSignal; onProgress?: (manifest: FeedbackManifest) => void }): Promise<FeedbackManifest> {
  input.signal.throwIfAborted();
  const snapshotAt = new Date().toISOString();
  const since = new Date(Date.now() - 10 * 60000).toISOString();
  // 不读取业务字段、事件 payload 或日志文件；附加诊断也只投影白名单字段。
  const snapshot = input.db.transaction(() => {
    if (!input.db.prepare('SELECT id FROM threads WHERE id=?').get(input.threadId)) throw new Error('FEEDBACK_THREAD_NOT_FOUND');
    const run = input.db.prepare('SELECT id,public_status,error_code,started_at,ended_at FROM runs WHERE thread_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(input.threadId) as { id: string; public_status: string; error_code: string | null; started_at: string | null; ended_at: string | null } | undefined;
    const diagnostics = input.includeDiagnostics ? input.db.prepare(`SELECT created_at,
      json_extract(record_json,'$.source') AS source,
      json_extract(record_json,'$.error_code') AS error_code,
      json_extract(record_json,'$.method') AS method,
      json_extract(record_json,'$.status') AS status
      FROM feedback_diagnostics WHERE thread_id=? AND julianday(created_at)>=julianday(?) AND julianday(created_at)<=julianday(?)
      AND (json_extract(record_json,'$.run_id') IS NULL OR json_extract(record_json,'$.run_id')=?)
      ORDER BY seq DESC LIMIT 200`).all(input.threadId, since, snapshotAt, run?.id ?? '') as Array<Record<string, unknown>> : [];
    return { run, diagnostics };
  })();
  const summary: Record<string, unknown> = { environment: feedbackEnvironment({ ...input.environment, ...input.native?.environment }) };
  if (snapshot.run) {
    const run = snapshot.run;
    const duration = Date.parse(run.ended_at ?? snapshotAt) - Date.parse(run.started_at ?? '');
    summary.run = { status: statuses.has(run.public_status) ? run.public_status : 'unknown',
      ...(run.error_code ? { error_code: errorCodes.has(run.error_code) ? run.error_code : 'UNKNOWN_ERROR' } : {}),
      ...(Number.isFinite(duration) && duration >= 0 ? { duration_ms: duration } : {}) };
  }
  const records: unknown[] = [summary, ...snapshot.diagnostics.reverse().map(row => ({
    timestamp: new Date(String(row.created_at)).toISOString(), source: row.source === 'web' ? 'web' : 'daemon',
    ...(typeof row.error_code === 'string' ? { error_code: errorCodes.has(row.error_code) ? row.error_code : 'UNKNOWN_ERROR' } : {}),
    ...(typeof row.method === 'string' && ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(row.method) ? { method: row.method } : {}),
    ...(typeof row.status === 'number' && Number.isInteger(row.status) && row.status >= 0 && row.status <= 599 ? { status: row.status } : {})
  }))];
  const data = Buffer.from(records.map(record => JSON.stringify(redactFeedback(record))).join('\n') + '\n');
  const id = randomUUID();
  const manifest: FeedbackManifest = { schema_version: 1, snapshot_at: snapshotAt, thread_id: input.threadId,
    collection_scope: input.includeDiagnostics ? 'diagnostics' : 'basic', run_ids: [], runtime_thread_ids: [], watermarks: [],
    completeness: 'complete', redaction_policy_version: 1,
    artifacts: [{ artifact_id: id, kind: 'diagnostics', name: 'diagnostics.ndjson', content_type: 'application/x-ndjson', size_bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'), record_count: records.length, source: 'lightweight', part_index: 1 }], missing_items: [], warnings: [] };
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  input.signal.throwIfAborted();
  await writeFile(join(input.directory, id), data, { mode: 0o600, flag: 'wx' });
  input.onProgress?.(manifest);
  return manifest;
}
