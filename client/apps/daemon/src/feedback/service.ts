import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { canonicalFeedbackJSON, FEEDBACK_ORIGIN, type FeedbackDraft, type FeedbackManifest } from '@clawee/protocol';
import { collectFeedback, type NativeFeedback } from './collector.js';
import { redactFeedback } from './redactor.js';

type StoredDraft = Omit<FeedbackDraft, 'external_feedback_allowed'> & { client_feedback_id: string; occurred_at: string; reproduction_steps: string; consent_at?: string; accept_partial?: boolean; created_at: string; uploaded_artifact_ids: string[]; environment?: Record<string, string>; redacted_description?: string; redacted_steps?: string };
type Secrets = { recovery_token: string; status_token: string; upload_token?: string; upload_expires_at?: string; recovery_expires_at?: string };
type Progress = { report_id: string; upload_token?: string; upload_expires_at?: string; recovery_expires_at: string; received_artifact_ids: string[]; upload_state: string; expires_at: string };
class UploadError extends Error { constructor(readonly status: number, readonly retryAfter: number) { super(`FEEDBACK_HTTP_${status}`); } }
async function atomicJSON(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}
export class FeedbackService {
  private controllers = new Map<string, AbortController>();
  private running = false;
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(private input: { db: Database.Database; dataDir: string; environment: () => Record<string, string>; policy: (refresh: boolean) => Promise<{ allowed?: boolean; expiresAt?: string }>; fetchImpl?: typeof fetch }) {}
  private directory(id: string) { if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('FEEDBACK_NOT_FOUND'); return join(this.input.dataDir, 'feedback', id); }
  private load(id: string): StoredDraft { this.directory(id); const row = this.input.db.prepare('SELECT draft_json FROM feedback_queue WHERE local_feedback_id=?').get(id) as { draft_json: string } | undefined; if (!row) throw new Error('FEEDBACK_NOT_FOUND'); return JSON.parse(row.draft_json) as StoredDraft; }
  private save(draft: StoredDraft) { const stored = this.input.db.prepare('SELECT draft_json FROM feedback_queue WHERE local_feedback_id=?').get(draft.local_feedback_id) as { draft_json: string } | undefined; if (stored && (JSON.parse(stored.draft_json) as StoredDraft).state === 'cancelled' && draft.state !== 'cancelled') return; this.input.db.prepare('INSERT INTO feedback_queue VALUES(?,?,?) ON CONFLICT(local_feedback_id) DO UPDATE SET draft_json=excluded.draft_json,updated_at=excluded.updated_at').run(draft.local_feedback_id, JSON.stringify(draft), new Date().toISOString()); }
  async allowed(refresh = true): Promise<boolean> {
    const path = join(this.input.dataDir, 'feedback', 'policy.json');
    await mkdir(join(this.input.dataDir, 'feedback'), { recursive: true, mode: 0o700 });
    let known: { allowed?: boolean; expiresAt?: string } = {};
    try { known = JSON.parse(await readFile(path, 'utf8')) as typeof known; } catch { /* 尚未获取企业策略时默认允许主动反馈。 */ }
    let current: typeof known = {};
    try { current = await this.input.policy(refresh); } catch { /* 已知过期策略不得绕过。 */ }
    // 本地禁用立即生效，但陈旧的本地允许不能覆盖中心已返回的禁用策略。
    if (current.allowed !== undefined && (refresh || current.allowed === false || known.allowed === undefined)) { known = current; await atomicJSON(path, known); }
    return known.allowed !== false && !(known.expiresAt && Date.parse(known.expiresAt) <= Date.now()) && !(current.expiresAt && Date.parse(current.expiresAt) <= Date.now());
  }
  private async requireAllowed(refresh = true) { if (!await this.allowed(refresh)) throw new Error('FEEDBACK_POLICY_DISABLED'); }
  recordDiagnostic(threadId: string, record: Record<string, unknown>) {
    if (!this.input.db.prepare('SELECT id FROM threads WHERE id=?').get(threadId)) return;
    this.input.db.transaction(() => {
      this.input.db.prepare('INSERT INTO feedback_diagnostics(thread_id,record_json,created_at) VALUES(?,?,?)').run(threadId, JSON.stringify(redactFeedback(record)), new Date().toISOString());
      this.input.db.prepare('DELETE FROM feedback_diagnostics WHERE created_at<? OR (thread_id=? AND seq NOT IN (SELECT seq FROM feedback_diagnostics WHERE thread_id=? ORDER BY seq DESC LIMIT 1000))').run(new Date(Date.now() - 30 * 86400000).toISOString(), threadId, threadId);
    })();
  }
  threadForRun(runId: string) { return (this.input.db.prepare('SELECT thread_id FROM runs WHERE id=?').get(runId) as { thread_id?: string } | undefined)?.thread_id; }
  async create(input: { thread_id: string; description: string; occurred_at: string; reproduction_steps?: string }) {
    await this.requireAllowed();
    if (!this.input.db.prepare('SELECT id FROM threads WHERE id=?').get(input.thread_id)) throw new Error('FEEDBACK_THREAD_NOT_FOUND');
    const count = (this.input.db.prepare('SELECT COUNT(*) AS count FROM feedback_queue').get() as { count: number }).count;
    if (count >= 20) throw new Error('FEEDBACK_DRAFT_LIMIT');
    const now = new Date().toISOString(); const draft: StoredDraft = { local_feedback_id: randomUUID(), client_feedback_id: randomUUID(), thread_id: input.thread_id, description: input.description, occurred_at: input.occurred_at, reproduction_steps: input.reproduction_steps ?? '', state: 'awaiting_consent', origin: FEEDBACK_ORIGIN, size_bytes: 0, screenshots: [], retry_count: 0, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), created_at: now, uploaded_artifact_ids: [] };
    const dir = this.directory(draft.local_feedback_id); await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
    const secrets: Secrets = { recovery_token: randomBytes(32).toString('base64url'), status_token: randomBytes(32).toString('base64url') };
    await writeFile(join(dir, 'credentials.json'), JSON.stringify(secrets), { mode: 0o600, flag: 'wx' }); this.save(draft); return this.get(draft.local_feedback_id);
  }
  async get(id: string): Promise<FeedbackDraft> {
    const d = this.load(id);
    const allowed = await this.allowed(false);
    let centreStatus: { processing_status?: string; public_resolution_summary?: string } = {};
    if (d.report_id && d.state === 'submitted' && allowed) { try { const secrets = await this.secrets(id); centreStatus = await this.request(`/reports/${d.report_id}/status`, 'GET', new AbortController(), undefined, secrets.status_token); } catch { /* 离线仍可读取本地回执。 */ } }
    return { local_feedback_id: id, thread_id: d.thread_id, description: d.description, state: d.state, origin: d.origin, manifest: d.manifest, manifest_sha256: d.manifest_sha256, size_bytes: d.size_bytes, screenshots: d.screenshots, report_id: d.report_id, error_code: d.error_code, consent_at: d.consent_at, retry_count: d.retry_count, next_retry_at: d.next_retry_at, expires_at: d.expires_at, external_feedback_allowed: allowed, centre_status: centreStatus.processing_status, public_resolution_summary: centreStatus.public_resolution_summary };
  }
  private editable(d: StoredDraft) { if (d.consent_at || d.report_id || d.state === 'collecting' || d.state === 'cancelled') throw new Error('FEEDBACK_SNAPSHOT_FROZEN'); }
  async screenshot(id: string, data: Buffer, mime: string) {
    await this.requireAllowed(); const d = this.load(id); this.editable(d);
    if (d.screenshots.length >= 5 || data.length > 10 * 1024 * 1024) throw new Error('FEEDBACK_SCREENSHOT_LIMIT');
    const image = sharp(data, { limitInputPixels: 25000000 }); const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || `image/${metadata.format}` !== mime || (metadata.pages ?? 1) > 1) throw new Error('FEEDBACK_INVALID_IMAGE');
    await image.raw().toBuffer();
    const screenshot_id = randomUUID(); await writeFile(join(this.directory(id), screenshot_id), data, { mode: 0o600, flag: 'wx' }); d.screenshots.push({ screenshot_id, content_type: mime, size_bytes: data.length }); d.manifest = undefined; d.manifest_sha256 = undefined; this.save(d); return { screenshot_id };
  }
  async removeScreenshot(id: string, screenshotId: string) { const d = this.load(id); this.editable(d); const found = d.screenshots.find(s => s.screenshot_id === screenshotId); if (!found) throw new Error('FEEDBACK_NOT_FOUND'); await rm(join(this.directory(id), found.screenshot_id)); d.screenshots = d.screenshots.filter(s => s !== found); d.manifest = undefined; d.manifest_sha256 = undefined; this.save(d); }
  async collect(id: string, native?: NativeFeedback) {
    await this.requireAllowed(); const d = this.load(id); this.editable(d); d.state = 'collecting'; d.error_code = undefined; d.manifest = undefined; d.manifest_sha256 = undefined; d.size_bytes = 0; this.save(d);
    const controller = new AbortController(); this.controllers.set(id, controller);
    void (async () => {
      try {
        for (const name of await readdir(this.directory(id))) if (/^[0-9a-f-]{36}$/.test(name) && !d.screenshots.some(s => s.screenshot_id === name)) await rm(join(this.directory(id), name), { force: true });
        const latest = this.input.db.prepare('SELECT model FROM runs WHERE thread_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(d.thread_id) as { model?: string } | undefined;
        d.environment = { ...this.input.environment(), ...native?.environment, model: latest?.model ?? 'unavailable' }; d.redacted_description = String(redactFeedback(d.description)); d.redacted_steps = String(redactFeedback(d.reproduction_steps));
        const screenshots: FeedbackManifest['artifacts'] = [];
        for (const screenshot of d.screenshots) { const data = await readFile(join(this.directory(id), screenshot.screenshot_id)); screenshots.push({ artifact_id: screenshot.screenshot_id, kind: 'screenshot', name: `screenshot-${screenshots.length + 1}`, content_type: screenshot.content_type, size_bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), record_count: 0, source: `screenshot:${screenshot.screenshot_id}`, part_index: 1 }); }
        const m = await collectFeedback({ db: this.input.db, dataDir: this.input.dataDir, directory: this.directory(id), threadId: d.thread_id, environment: d.environment, native, signal: controller.signal, onProgress: manifest => { d.manifest = { ...manifest, completeness: 'partial', missing_items: [...manifest.missing_items, 'collection:in_progress'], artifacts: [...manifest.artifacts, ...screenshots] }; d.size_bytes = d.manifest.artifacts.reduce((n, a) => n + a.size_bytes, 0); this.save(d); } });
        m.artifacts.push(...screenshots);
        controller.signal.throwIfAborted(); d.manifest = m; d.manifest_sha256 = createHash('sha256').update(canonicalFeedbackJSON(m)).digest('hex'); d.size_bytes = m.artifacts.reduce((n, a) => n + a.size_bytes, 0); if (m.artifacts.length > 256 || d.size_bytes > 200 * 1024 * 1024) throw new Error('FEEDBACK_QUOTA_EXCEEDED'); d.state = 'awaiting_consent'; this.save(d);
      } catch (error) { if (!this.closed && this.load(id).state !== 'cancelled') { d.state = 'failed'; d.error_code = (error as Error).message === 'FEEDBACK_QUOTA_EXCEEDED' ? 'FEEDBACK_QUOTA_EXCEEDED' : 'FEEDBACK_COLLECTION_FAILED'; d.manifest_sha256 = undefined; if (d.manifest) { d.manifest.completeness = 'partial'; d.manifest.missing_items = d.manifest.missing_items.filter(item => item !== 'collection:in_progress'); d.manifest.missing_items.push(d.error_code === 'FEEDBACK_QUOTA_EXCEEDED' ? 'collection:quota_exceeded' : 'collection:interrupted'); } this.save(d); } }
      finally { this.controllers.delete(id); }
    })();
  }
  async send(id: string, input: { confirmed: boolean; manifest_sha256: string; accept_partial: boolean }) {
    await this.requireAllowed(); const d = this.load(id);
    if (!input.confirmed || !d.manifest || input.manifest_sha256 !== d.manifest_sha256 || d.state !== 'awaiting_consent' || (d.manifest.completeness === 'partial' && !input.accept_partial) || Date.parse(d.expires_at) <= Date.now()) throw new Error('FEEDBACK_CONSENT_REQUIRED');
    d.consent_at = new Date().toISOString(); d.accept_partial = input.accept_partial; d.state = 'queued'; this.save(d); this.start();
  }
  async retry(id: string) { await this.requireAllowed(); const d = this.load(id); if (!d.consent_at || !d.manifest || d.state !== 'failed' || Date.parse(d.expires_at) <= Date.now()) throw new Error('FEEDBACK_RETRY_NOT_ALLOWED'); const secrets = await this.secrets(id); if (secrets.recovery_expires_at && Date.parse(secrets.recovery_expires_at) <= Date.now()) throw new Error('FEEDBACK_EXPIRED'); d.state = 'queued'; d.retry_count = 0; d.error_code = undefined; d.next_retry_at = undefined; this.save(d); this.start(); }
  async cancel(id: string) { const d = this.load(id); if (d.state === 'submitted') throw new Error('FEEDBACK_ALREADY_SUBMITTED'); d.state = 'cancelled'; this.save(d); this.controllers.get(id)?.abort(); return { centre_materials_may_remain: Boolean(d.report_id) }; }
  private async secrets(id: string): Promise<Secrets> { return JSON.parse(await readFile(join(this.directory(id), 'credentials.json'), 'utf8')) as Secrets; }
  private async saveSecrets(id: string, secrets: Secrets) { await atomicJSON(join(this.directory(id), 'credentials.json'), secrets); }
  private async request<T>(path: string, method: string, controller: AbortController, body?: unknown, token?: string, artifact?: FeedbackManifest['artifacts'][number], id?: string): Promise<T> {
    await this.requireAllowed(false); controller.signal.throwIfAborted();
    const headers: Record<string, string> = {}; if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (artifact) { headers['Content-Type'] = artifact.content_type; headers['Content-Length'] = String(artifact.size_bytes); headers['X-Content-SHA256'] = artifact.sha256; }
    const stream = artifact && id ? createReadStream(join(this.directory(id), artifact.artifact_id)) : undefined;
    try {
      const response = await (this.input.fetchImpl ?? fetch)(`${FEEDBACK_ORIGIN}/api/v1/feedback${path}`, { method, headers, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]), body: stream as unknown as BodyInit ?? (body === undefined ? undefined : JSON.stringify(body)), ...(stream ? { duplex: 'half' } : {}) } as RequestInit);
      if (!response.ok) { const value = response.headers.get('Retry-After'); const seconds = value === null ? 0 : /^\d+$/.test(value) ? Number(value) * 1000 : Math.max(0, Date.parse(value) - Date.now()); await response.body?.cancel(); throw new UploadError(response.status, seconds); }
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (!reader) throw new Error('FEEDBACK_PROTOCOL_ERROR');
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2 * 1024 * 1024) throw new Error('FEEDBACK_PROTOCOL_ERROR'); chunks.push(part.value); } }
      finally { await reader.cancel(); }
      try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: T }; if (!parsed?.data || typeof parsed.data !== 'object') throw new Error(); return parsed.data; } catch { throw new Error('FEEDBACK_PROTOCOL_ERROR'); }
    } finally { stream?.destroy(); }
  }
  private async upload(d: StoredDraft, controller: AbortController) {
    const id = d.local_feedback_id; const secrets = await this.secrets(id); const m = d.manifest!;
    d.state = 'uploading'; this.save(d);
    const update = async (p: Progress) => { d.report_id = p.report_id; d.uploaded_artifact_ids = p.received_artifact_ids; secrets.upload_token = p.upload_token ?? secrets.upload_token; secrets.upload_expires_at = p.upload_expires_at ?? secrets.upload_expires_at; secrets.recovery_expires_at = p.recovery_expires_at; d.expires_at = p.expires_at; await this.saveSecrets(id, secrets); controller.signal.throwIfAborted(); this.save(d); return p; };
    let p: Progress;
    if (!d.report_id) p = await update(await this.request<Progress>('/reports', 'POST', controller, { client_feedback_id: d.client_feedback_id, recovery_token: secrets.recovery_token, status_token: secrets.status_token, description: d.redacted_description, occurred_at: d.occurred_at, reproduction_steps: d.redacted_steps, environment: d.environment, source_claim: {}, consent: { policy_version: 1, confirmed_at: d.consent_at }, manifest: m }));
    else p = await update(await this.request<Progress>(`/reports/${d.report_id}/upload-credentials`, 'POST', controller, undefined, secrets.recovery_token));
    if (p.upload_state === 'ready') { d.state = 'submitted'; d.expires_at = new Date(Date.now() + 7 * 86400000).toISOString(); this.save(d); return; }
    for (const artifact of m.artifacts) {
      if (d.uploaded_artifact_ids.includes(artifact.artifact_id)) continue;
      // 顺序上传自然满足最多两个并发，恢复时无在途请求。
      if (Date.parse(secrets.upload_expires_at ?? '') <= Date.now()) await update(await this.request<Progress>(`/reports/${d.report_id}/upload-credentials`, 'POST', controller, undefined, secrets.recovery_token));
      try { await this.request(`/reports/${d.report_id}/artifacts/${artifact.artifact_id}`, 'PUT', controller, undefined, secrets.upload_token, artifact, id); }
      catch (error) { if (!(error instanceof UploadError) || error.status !== 401 || Date.parse(secrets.recovery_expires_at ?? '') <= Date.now()) throw error; await update(await this.request<Progress>(`/reports/${d.report_id}/upload-credentials`, 'POST', controller, undefined, secrets.recovery_token)); await this.request(`/reports/${d.report_id}/artifacts/${artifact.artifact_id}`, 'PUT', controller, undefined, secrets.upload_token, artifact, id); }
      controller.signal.throwIfAborted(); d.uploaded_artifact_ids.push(artifact.artifact_id); this.save(d);
    }
    const submit = () => this.request(`/reports/${d.report_id}/submit`, 'POST', controller, { manifest_sha256: d.manifest_sha256, accept_partial: d.accept_partial }, secrets.upload_token);
    try { await submit(); } catch (error) { if (!(error instanceof UploadError) || error.status !== 401 || Date.parse(secrets.recovery_expires_at ?? '') <= Date.now()) throw error; const recovered = await update(await this.request<Progress>(`/reports/${d.report_id}/upload-credentials`, 'POST', controller, undefined, secrets.recovery_token)); if (recovered.upload_state !== 'ready') await submit(); }
    controller.signal.throwIfAborted(); d.state = 'submitted'; d.error_code = undefined; d.expires_at = new Date(Date.now() + 7 * 86400000).toISOString(); this.save(d);
  }
  start() { if (this.closed || this.running || this.timer) return; this.timer = setTimeout(() => { this.timer = undefined; void this.work(); }, 100); this.timer.unref(); }
  private async work() {
    if (this.running || this.closed) return; this.running = true;
    try {
      const drafts = (this.input.db.prepare('SELECT draft_json FROM feedback_queue').all() as Array<{ draft_json: string }>).map(row => JSON.parse(row.draft_json) as StoredDraft);
      let uploadAllowed: boolean | undefined;
      for (const d of drafts) {
        if (Date.parse(d.expires_at) <= Date.now()) { await rm(this.directory(d.local_feedback_id), { recursive: true, force: true }); this.input.db.prepare('DELETE FROM feedback_queue WHERE local_feedback_id=?').run(d.local_feedback_id); continue; }
        if (d.state === 'collecting' && !this.controllers.has(d.local_feedback_id)) { d.state = 'failed'; d.error_code = 'FEEDBACK_COLLECTION_INTERRUPTED'; d.manifest_sha256 = undefined; if (d.manifest) { d.manifest.completeness = 'partial'; d.manifest.missing_items = d.manifest.missing_items.filter(item => item !== 'collection:in_progress'); d.manifest.missing_items.push('collection:interrupted'); } this.save(d); }
        if (!['queued', 'uploading'].includes(d.state) || Date.parse(d.next_retry_at ?? '') > Date.now()) continue;
        uploadAllowed ??= await this.allowed();
        if (!uploadAllowed) continue;
        if (this.closed) break;
        const controller = new AbortController(); this.controllers.set(d.local_feedback_id, controller);
        if (!['queued', 'uploading'].includes(this.load(d.local_feedback_id).state)) { this.controllers.delete(d.local_feedback_id); continue; }
        try { await this.upload(d, controller); }
        catch (error) {
          if (this.closed || this.load(d.local_feedback_id).state === 'cancelled') continue;
          if ((error as Error).message === 'FEEDBACK_POLICY_DISABLED') continue;
          const retry = (error as Error).message !== 'FEEDBACK_PROTOCOL_ERROR' && (!(error instanceof UploadError) || [408, 429].includes(error.status) || error.status >= 500);
          d.retry_count++; d.error_code = error instanceof UploadError ? error.message : 'FEEDBACK_UPLOAD_FAILED';
          d.state = retry && d.retry_count < 10 ? 'queued' : 'failed';
          d.next_retry_at = new Date(Date.now() + Math.max(error instanceof UploadError ? error.retryAfter : 0, Math.min(300000, 2000 * 2 ** (d.retry_count - 1)) * (0.75 + Math.random() * 0.5))).toISOString(); this.save(d);
        } finally { this.controllers.delete(d.local_feedback_id); }
      }
    } finally { this.running = false; if (!this.closed) { this.timer = setTimeout(() => { this.timer = undefined; void this.work(); }, 2000); this.timer.unref(); } }
  }
  async export(id: string) { const d = this.load(id); if (!d.manifest) throw new Error('FEEDBACK_NOT_READY'); return d.manifest; }
  async artifact(id: string, aid: string) { const d = this.load(id); if (!d.manifest?.artifacts.some(a => a.artifact_id === aid)) throw new Error('FEEDBACK_NOT_FOUND'); return createReadStream(join(this.directory(id), aid)); }
  close() { this.closed = true; if (this.timer) clearTimeout(this.timer); for (const controller of this.controllers.values()) controller.abort(); }
}
