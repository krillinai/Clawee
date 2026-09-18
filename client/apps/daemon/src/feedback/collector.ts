import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import type { FeedbackArtifact, FeedbackManifest, PublicRunStatus } from '@clawee/protocol';
import { redactFeedback } from './redactor.js';
import { mergeRunEventsIntoThreadHistory } from '../threads/run-event-history.js';
import { diagnosticLogWriterLoss } from '../diagnostics/collector.js';

type Row = Record<string, unknown>;
type FileBoundary = { run_id: string; name: string; path: string; size: number; ino: number; dev: number };
export type NativeFeedback = { environment: Record<string, string>; records: unknown[]; warnings: string[] };
export async function collectFeedback(input: { db: Database.Database; dataDir: string; directory: string; threadId: string; environment: Record<string, string>; native?: NativeFeedback; signal: AbortSignal; onProgress?: (manifest: FeedbackManifest) => void }): Promise<FeedbackManifest> {
  const { db, signal } = input;
  const snapshotAt = new Date().toISOString();
  const snapshot = db.transaction(() => {
    const thread = db.prepare('SELECT * FROM threads WHERE id=?').get(input.threadId) as Row | undefined;
    if (!thread) throw new Error('FEEDBACK_THREAD_NOT_FOUND');
    const runs = db.prepare('SELECT * FROM runs WHERE thread_id=? ORDER BY created_at,id').all(input.threadId) as Row[];
    const boundaries = runs.map(run => ({ run_id: String(run.id), max_event_seq: Number((db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM run_events WHERE run_id=?').get(run.id) as { seq: number }).seq), expected_count: Number((db.prepare('SELECT COUNT(*) AS count FROM run_events WHERE run_id=?').get(run.id) as { count: number }).count), exported_count: 0 }));
    const runtimeIds = [...new Set([thread.codex_thread_id, ...runs.map(run => run.codex_thread_id), ...(db.prepare('SELECT runtime_thread_id FROM feedback_runtime_threads WHERE thread_id=?').all(input.threadId) as Array<{ runtime_thread_id: string }>).map(row => row.runtime_thread_id)].filter((id): id is string => typeof id === 'string'))];
    const runtime = runtimeIds.map(id => ({ id, session: db.prepare('SELECT s.*,src.parsed_offset,src.file_size,src.last_error FROM codex_sessions s JOIN codex_session_sources src ON src.path=s.source_path WHERE codex_thread_id=?').get(id) as Row | undefined })).map(item => ({ ...item, maxOffset: item.session ? Number((db.prepare('SELECT COALESCE(MAX(source_offset),-1) AS offset FROM codex_session_items WHERE source_path=?').get(item.session.source_path) as { offset: number }).offset) : -1, expectedCount: item.session ? Number((db.prepare('SELECT COUNT(*) AS count FROM codex_session_items WHERE source_path=?').get(item.session.source_path) as { count: number }).count) : 0 }));
    const attachments = db.prepare('SELECT id,file_name,mime,size,sha256,run_id,created_at FROM attachments WHERE thread_id=? ORDER BY created_at,id').all(input.threadId) as Row[];
    const scheduleTraces = db.prepare('SELECT * FROM schedule_operations WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?)').all(input.threadId) as Row[];
    const diagnosticBoundary = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq,COUNT(*) AS count FROM feedback_diagnostics WHERE thread_id=?').get(input.threadId) as { seq: number; count: number };
    return { thread, runs, boundaries, runtimeIds, runtime, attachments, scheduleTraces, diagnosticBoundary };
  })();
  const m: FeedbackManifest = { schema_version: 1, snapshot_at: snapshotAt, thread_id: input.threadId, run_ids: snapshot.runs.map(run => String(run.id)), runtime_thread_ids: snapshot.runtimeIds, watermarks: snapshot.boundaries, completeness: 'complete', redaction_policy_version: 1, artifacts: [], missing_items: [], warnings: ['自动脱敏为尽力处理，截图与业务正文仍需人工检查。'] };
  const paths = [...new Set(snapshot.runs.flatMap(run => [String(run.cwd), String(run.codex_home)]).concat(String(snapshot.thread.cwd)))];
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const files: FileBoundary[] = [];
  for (const run of snapshot.runs) {
    if (!/^run_[A-Za-z0-9_-]+$/.test(String(run.id))) { m.missing_items.push(`run:${run.id}:unsafe_id`); continue; }
    for (const name of ['meta.json', 'events.ndjson', 'raw.redacted.ndjson', 'stderr.redacted.log', 'diagnostics.json']) {
      const path = join(input.dataDir, 'runs', String(run.id), name);
      try { const f = await safeOpen(path, join(input.dataDir, 'runs')); const stat = await f.stat(); await f.close(); files.push({ run_id: String(run.id), name, path, size: stat.size, ino: stat.ino, dev: stat.dev }); m.watermarks.push({ run_id: String(run.id), source: name, size_bytes: stat.size, boundary: 'file_bytes_at_collection' }); }
      catch { m.missing_items.push(`run:${run.id}:${name}:unavailable`); }
    }
  }
  async function writeSource(kind: FeedbackArtifact['kind'], source: string, records: AsyncIterable<unknown>) {
    let part = 0; let bytes = 0; let count = 0; let position = 0; let first = 0; let handle: Awaited<ReturnType<typeof open>> | undefined; let hash = createHash('sha256'); let id = '';
    const finish = async () => { if (!handle) return; await handle.truncate(bytes); await handle.close(); handle = undefined; m.artifacts.push({ artifact_id: id, kind, name: `${kind}-${m.artifacts.length + 1}.ndjson`, content_type: 'application/x-ndjson', size_bytes: bytes, sha256: hash.digest('hex'), record_count: count, source, part_index: part, first_record: first, last_record: position }); input.onProgress?.(m); };
    try {
      for await (const record of records) {
        signal.throwIfAborted(); const data = Buffer.from(`${JSON.stringify(redactFeedback(record, paths))}\n`);
        if (data.length > 16 * 1024 * 1024) { m.missing_items.push(`${source}:record_${position + 1}:too_large`); position++; continue; }
        if (handle && bytes + data.length > 8 * 1024 * 1024) await finish();
        if (!handle) { id = randomUUID(); handle = await open(join(input.directory, id), 'wx', 0o600); part++; bytes = 0; count = 0; hash = createHash('sha256'); first = position + 1; }
        await handle.writeFile(data); hash.update(data); bytes += data.length; count++; position++;
        if (m.artifacts.length >= 256 || m.artifacts.reduce((n, a) => n + a.size_bytes, 0) + bytes > 200 * 1024 * 1024) throw new Error('FEEDBACK_QUOTA_EXCEEDED');
      }
      await finish();
    } finally { await finish(); }
  }
  async function* rows(values: unknown[]) { for (const value of values) yield value; }
  await writeSource('environment', 'environment', rows([{ ...input.environment, ...input.native?.environment }]));
  await writeSource('diagnostics', 'thread_metadata', rows([{ thread: snapshot.thread, runs: snapshot.runs, schedule_operations: snapshot.scheduleTraces }]));
  await writeSource('attachments', 'attachment_index', rows(snapshot.attachments.length ? snapshot.attachments : [{ count: 0 }]));
  const prompts = mergeRunEventsIntoThreadHistory([], [...snapshot.runs].reverse().map(run => ({ id: String(run.id), publicPrompt: typeof run.public_prompt === 'string' ? run.public_prompt : undefined, createdAt: String(run.created_at), status: run.public_status as PublicRunStatus })), () => []);
  await writeSource('conversation', 'run_prompts', rows(prompts.map(item => ({ source: 'run_prompt', run_id: item.id.slice('run-prompt:'.length), item }))));
  m.watermarks.push({ source: 'run_prompts', expected_count: prompts.length, exported_count: m.artifacts.filter(a => a.source === 'run_prompts').reduce((n, a) => n + a.record_count, 0), boundary: 'run_set_at_snapshot' });
  for (const boundary of snapshot.boundaries) {
    async function* events() {
      let after = 0;
      while (after < boundary.max_event_seq) {
        signal.throwIfAborted(); const page = db.prepare('SELECT * FROM run_events WHERE run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 250').all(boundary.run_id, after, boundary.max_event_seq) as Row[];
        if (!page.length) break;
        for (const event of page) { after = Number(event.seq); const payload = JSON.parse(String(event.payload_json)) as unknown; yield { source: 'run_events', ...event, payload_json: undefined, payload }; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    await writeSource('conversation', `run_events:${boundary.run_id}`, events());
    boundary.exported_count = m.artifacts.filter(a => a.source === `run_events:${boundary.run_id}`).reduce((n, a) => n + a.record_count, 0);
    if (boundary.exported_count !== boundary.expected_count) m.missing_items.push(`run:${boundary.run_id}:event_count_mismatch`);
  }
  if (!snapshot.runs.length) await writeSource('conversation', 'thread_empty', rows([{ source: 'thread', event: 'no_local_runs' }]));
  for (const runtime of snapshot.runtime) {
    if (!runtime.session) { m.missing_items.push(`runtime:${runtime.id}:history_unavailable`); continue; }
    if (Number(runtime.session.parsed_offset) < Number(runtime.session.file_size) || runtime.session.last_error) m.missing_items.push(`runtime:${runtime.id}:index_incomplete`);
    const sourcePath = runtime.session.source_path;
    const watermark = { source: `runtime:${runtime.id}`, expected_count: runtime.expectedCount, exported_count: 0, boundary: `indexed_offset:${runtime.maxOffset}` }; m.watermarks.push(watermark);
    async function* history() {
      let after = -1;
      while (after < runtime.maxOffset) {
        const page = db.prepare('SELECT * FROM codex_session_items WHERE source_path=? AND source_offset>? AND source_offset<=? ORDER BY source_offset LIMIT 250').all(sourcePath, after, runtime.maxOffset) as Row[];
        if (!page.length) break;
        for (const item of page) { after = Number(item.source_offset); yield { source: 'runtime_history', runtime_thread_id: runtime.id, source_offset: item.source_offset, item: JSON.parse(String(item.item_json)) as unknown }; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    await writeSource('conversation', `runtime:${runtime.id}`, history());
    watermark.exported_count = m.artifacts.filter(a => a.source === `runtime:${runtime.id}`).reduce((n, a) => n + a.record_count, 0);
    if (watermark.expected_count !== watermark.exported_count) m.missing_items.push(`runtime:${runtime.id}:count_mismatch`);
  }
  for (const file of files) {
    if (!file.size) continue;
    async function* lines() {
      const f = await safeOpen(file.path, join(input.dataDir, 'runs')); const stat = await f.stat();
      if (stat.ino !== file.ino || stat.dev !== file.dev || stat.size < file.size) { await f.close(); throw new Error('FEEDBACK_SOURCE_CHANGED'); }
      const stream = f.createReadStream({ start: 0, end: file.size - 1, autoClose: false });
      let diagnostics = '';
      try {
        for await (const line of boundedLines(stream, signal)) {
          if (file.name === 'diagnostics.json' && file.size <= 16 * 1024 * 1024) diagnostics += `${line}\n`;
          let value: unknown = line; try { value = JSON.parse(line) as unknown; } catch { /* 文本日志也导出为有效 NDJSON。 */ }
          yield { source: file.name, run_id: file.run_id, record: value };
        }
        if (stream.bytesRead !== file.size) throw new Error('FEEDBACK_SOURCE_CHANGED');
        if (diagnostics) {
          const { failureCount, backpressureRejects } = diagnosticLogWriterLoss(JSON.parse(diagnostics));
          if (failureCount > 0) m.missing_items.push(`run:${file.run_id}:log_write_failed`);
          if (backpressureRejects > 0) m.missing_items.push(`run:${file.run_id}:log_backpressure_rejected`);
          if (failureCount > 0 || backpressureRejects > 0) for (const watermark of m.watermarks) if (watermark.run_id === file.run_id && watermark.source) watermark.source_truncated = true;
        }
      }
      finally { stream.destroy(); await f.close(); }
    }
    try { await writeSource('logs', `file:${file.run_id}:${file.name}`, lines()); }
    catch (error) { if (signal.aborted || (error as Error).message === 'FEEDBACK_QUOTA_EXCEEDED') throw error; m.missing_items.push(`run:${file.run_id}:${file.name}:read_failed`); }
  }
  if (input.native) { await writeSource('logs', 'desktop', rows(input.native.records)); m.warnings.push(...input.native.warnings); }
  else m.missing_items.push('desktop_logs:unavailable');
  if (snapshot.diagnosticBoundary.count) {
    async function* diagnostics() {
      let after = 0;
      while (after < snapshot.diagnosticBoundary.seq) {
        const page = db.prepare('SELECT * FROM feedback_diagnostics WHERE thread_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 250').all(input.threadId, after, snapshot.diagnosticBoundary.seq) as Row[];
        if (!page.length) break;
        for (const row of page) { after = Number(row.seq); yield { seq: row.seq, created_at: row.created_at, ...JSON.parse(String(row.record_json)) as Row }; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    await writeSource('logs', 'correlated_diagnostics', diagnostics());
    const count = m.artifacts.filter(a => a.source === 'correlated_diagnostics').reduce((n, a) => n + a.record_count, 0);
    m.watermarks.push({ source: 'correlated_diagnostics', expected_count: snapshot.diagnosticBoundary.count, exported_count: count, boundary: `seq:${snapshot.diagnosticBoundary.seq}` });
    if (count !== snapshot.diagnosticBoundary.count) m.missing_items.push('correlated_diagnostics:count_mismatch');
  }
  m.missing_items.push('web_daemon_errors:historical_or_retention_boundary_unavailable');
  // 文件与多进程源不能提供原子快照，不伪称 complete。
  if (files.length) m.missing_items.push('run_file_flush:stable_snapshot_boundary_unavailable');
  if (m.missing_items.length) m.completeness = 'partial';
  return m;
}
export async function* boundedLines(stream: AsyncIterable<Buffer | string>, signal: AbortSignal): AsyncGenerator<string> {
  let chunks: Buffer[] = []; let size = 0;
  for await (const chunk of stream) {
    signal.throwIfAborted(); const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); let start = 0;
    for (let i = 0; i <= data.length; i++) {
      if (i !== data.length && data[i] !== 10) continue;
      const piece = data.subarray(start, i); size += piece.length;
      if (size > 16 * 1024 * 1024) throw new Error('FEEDBACK_SOURCE_LINE_TOO_LARGE');
      if (piece.length) chunks.push(piece);
      if (i < data.length) { yield Buffer.concat(chunks, size).toString('utf8').replace(/\r$/, ''); chunks = []; size = 0; }
      start = i + 1;
    }
  }
  if (size) yield Buffer.concat(chunks, size).toString('utf8').replace(/\r$/, '');
}
export async function safeOpen(path: string, root: string) {
  const actualRoot = await realpath(root); const actual = await realpath(path); const rel = relative(actualRoot, actual);
  if (rel.startsWith('..') || isAbsolute(rel) || actual !== path) throw new Error('FEEDBACK_UNSAFE_PATH');
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = await f.stat();
  if (!stat.isFile()) { await f.close(); throw new Error('FEEDBACK_UNSAFE_PATH'); } return f;
}
