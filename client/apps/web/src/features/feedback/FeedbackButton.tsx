import { Bug, Download, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FeedbackDraft } from '@clawee/protocol';
import type { RuntimeClient } from '../../runtime/client.js';
import './feedback.css';

const states: Record<FeedbackDraft['state'], string> = { collecting: '正在采集', awaiting_consent: '等待确认', queued: '等待上传', uploading: '正在上传', submitted: '已提交', failed: '未完成', cancelled: '已取消' };
export function FeedbackButton({ client, threadId }: { client: RuntimeClient | null; threadId: string }) {
  const [allowed, setAllowed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    client?.setFeedbackThread(threadId);
    const error = () => client?.recordFeedbackError('browser_error'); const rejection = () => client?.recordFeedbackError('unhandled_rejection');
    window.addEventListener('error', error); window.addEventListener('unhandledrejection', rejection);
    return () => { client?.setFeedbackThread(undefined); window.removeEventListener('error', error); window.removeEventListener('unhandledrejection', rejection); };
  }, [client, threadId]);
  useEffect(() => { let active = true; setAllowed(false); void client?.get<{ external_feedback_allowed: boolean }>('/feedback/policy').then(p => { if (active) setAllowed(p.external_feedback_allowed); }).catch(() => {}); return () => { active = false; }; }, [client, threadId]);
  if (!client || !allowed) return null;
  return <><button type="button" className="sidebar-collapse-button" title="反馈当前会话问题" aria-label="反馈当前会话问题" onClick={() => setOpen(true)}><Bug size={18} /></button>{open ? <FeedbackDialog client={client} threadId={threadId} onClose={() => setOpen(false)} /> : null}</>;
}
function FeedbackDialog({ client, threadId, onClose }: { client: RuntimeClient; threadId: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 16));
  const [screenshots, setScreenshots] = useState<File[]>([]);
  const [draft, setDraft] = useState<FeedbackDraft>();
  const [confirmed, setConfirmed] = useState(false);
  const [partial, setPartial] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const receiptKey = `clawee-feedback:${threadId}`;
  useEffect(() => { dialog.current?.showModal(); const id = localStorage.getItem(receiptKey); if (id) void client.get<FeedbackDraft>(`/feedback/drafts/${id}`).then(setDraft).catch(() => localStorage.removeItem(receiptKey)); }, [client, receiptKey]);
  useEffect(() => { if (!draft || !['collecting', 'queued', 'uploading'].includes(draft.state)) return; let active = true; const timer = setInterval(() => { void client.get<FeedbackDraft>(`/feedback/drafts/${draft.local_feedback_id}`).then(next => { if (active) setDraft(next); }).catch(() => { if (active) setError('无法读取本地进度，资料仍保留在本机。'); }); }, 2000); return () => { active = false; clearInterval(timer); }; }, [client, draft?.local_feedback_id, draft?.state]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch { setError('操作未完成，请检查本地服务、部署策略或网络后重试。'); } finally { setBusy(false); } }
  const refresh = async (id: string) => setDraft(await client.get<FeedbackDraft>(`/feedback/drafts/${id}`));
  async function collect() {
    const created = await client.post<FeedbackDraft>('/feedback/drafts', { thread_id: threadId, description, reproduction_steps: steps, occurred_at: new Date(occurredAt).toISOString() });
    localStorage.setItem(receiptKey, created.local_feedback_id); setDraft(created);
    for (const file of screenshots) await client.postBinary(`/feedback/drafts/${created.local_feedback_id}/screenshots`, file, file.type);
    let native; try { native = await window.claweeDesktop?.collectFeedback?.(threadId); } catch { /* 原生日志不可用时仍采集会话并明确 partial。 */ }
    await client.post(`/feedback/drafts/${created.local_feedback_id}/collect`, { native }); await refresh(created.local_feedback_id);
  }
  async function exportFiles() {
    if (!draft?.manifest) return;
    const download = (blob: Blob, name: string) => { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    download(new Blob([JSON.stringify({ description: draft.description, manifest: draft.manifest }, null, 2)], { type: 'application/json' }), 'feedback-manifest.json');
    for (const a of draft.manifest.artifacts) { const response = await client.rawGet(`/feedback/drafts/${draft.local_feedback_id}/artifacts/${a.artifact_id}`); download(await response.blob(), a.name); }
  }
  const frozen = draft !== undefined;
  return createPortal(<dialog ref={dialog} className="feedback-dialog" onCancel={onClose}>
    <header><h2>反馈当前会话问题</h2><button type="button" aria-label="关闭" title="关闭" onClick={onClose}><X size={18} /></button></header>
    <div className="feedback-dialog-body" onPaste={event => { if (frozen) return; const files = Array.from(event.clipboardData.files).filter(f => ['image/png', 'image/jpeg', 'image/webp'].includes(f.type)); if (files.length) { event.preventDefault(); setScreenshots(old => [...old, ...files].slice(0, 5)); } }}>
      <p>接收方：Clawee 软件维护方<br />接收域名：gateway.clawee.work<br />当前会话：{threadId}</p>
      <label>问题描述<textarea maxLength={10000} value={draft?.description ?? description} disabled={frozen} onChange={e => setDescription(e.target.value)} /></label>
      {!frozen ? <><label>发生时间<input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} /></label><label>复现步骤<textarea maxLength={10000} value={steps} onChange={e => setSteps(e.target.value)} /></label><label>问题截图<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => { setScreenshots(old => [...old, ...Array.from(e.target.files ?? [])].slice(0, 5)); e.target.value = ''; }} /></label><div className="feedback-screenshots">{screenshots.map((file, index) => <ScreenshotEditor key={`${index}:${file.name}`} file={file} onChange={next => setScreenshots(old => old.map((f, i) => i === index ? next : f))} onRemove={() => setScreenshots(old => old.filter((_, i) => i !== index))} />)}</div></> : null}
      {draft ? <><p aria-live="polite">{states[draft.state]} · {(draft.size_bytes / 1024 / 1024).toFixed(2)} MiB{draft.report_id ? ` · ${draft.report_id}` : ''}</p>{draft.centre_status ? <p>中心处理状态：{draft.centre_status}<br />{draft.public_resolution_summary}</p> : null}<p>本地材料保留至 {new Date(draft.expires_at).toLocaleString()}</p>{draft.manifest ? <><h3>材料清单</h3><ul>{draft.manifest.artifacts.map(a => <li key={a.artifact_id}>{a.name} · {a.record_count} 条 · {(a.size_bytes / 1024).toFixed(1)} KiB</li>)}</ul>{draft.manifest.missing_items.length ? <><h3>缺失项（partial）</h3><ul>{draft.manifest.missing_items.map(item => <li key={item}>{item}</li>)}</ul></> : null}</> : null}{draft.error_code ? <p role="alert">{draft.error_code}；材料保留在本机。</p> : null}</> : null}
      {draft?.state === 'awaiting_consent' && draft.manifest ? <><label className="feedback-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />将问题描述、截图及当前会话的完整已留存记录和相关诊断日志发送给 Clawee 软件维护方 gateway.clawee.work。资料可能包含业务内容，请确认可以发送。</label>{draft.manifest.completeness === 'partial' ? <label className="feedback-check"><input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} />已查看缺失项，同意发送部分资料</label> : null}</> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div><footer>
      {!draft ? <button type="button" disabled={busy || !description.trim()} onClick={() => void run(collect)}>采集并预览</button> : null}
      {draft?.state === 'awaiting_consent' && !draft.manifest ? <button type="button" disabled={busy} onClick={() => void run(async () => { await client.post(`/feedback/drafts/${draft.local_feedback_id}/collect`, {}); await refresh(draft.local_feedback_id); })}>重新采集</button> : null}
      {draft?.state === 'awaiting_consent' && draft.manifest ? <button type="button" disabled={busy || !confirmed || (draft.manifest.completeness === 'partial' && !partial)} onClick={() => void run(async () => { await client.post(`/feedback/drafts/${draft.local_feedback_id}/send`, { confirmed, manifest_sha256: draft.manifest_sha256, accept_partial: partial }); await refresh(draft.local_feedback_id); })}>确认发送</button> : null}
      {draft?.state === 'failed' && draft.error_code !== 'FEEDBACK_QUOTA_EXCEEDED' ? <button type="button" disabled={busy} onClick={() => void run(async () => { await client.post(`/feedback/drafts/${draft.local_feedback_id}/${draft.consent_at ? 'retry' : 'collect'}`, {}); await refresh(draft.local_feedback_id); })}>重试</button> : null}
      {draft?.error_code === 'FEEDBACK_QUOTA_EXCEEDED' ? <p role="alert">材料超过上传限额，已生成资料可本地导出。请联系维护方调整限额；本次反馈尚未完整采集，不能发送。</p> : null}
      {draft?.manifest ? <button type="button" disabled={busy} onClick={() => void run(exportFiles)}><Download size={16} />本地导出</button> : null}
      {draft && !['submitted', 'cancelled'].includes(draft.state) ? <button type="button" disabled={busy} onClick={() => void run(async () => { await client.post(`/feedback/drafts/${draft.local_feedback_id}/cancel`); await refresh(draft.local_feedback_id); })}>取消上传</button> : null}
      {draft ? <button type="button" disabled={busy || ['collecting', 'queued', 'uploading'].includes(draft.state)} onClick={() => { localStorage.removeItem(receiptKey); setDraft(undefined); setConfirmed(false); setPartial(false); }}>新建反馈</button> : null}
    </footer><p className="feedback-footnote">取消不会立即删除中心已接收资料。截图不保证自动脱敏，匿名提交不代表没有个人或企业数据。</p>
  </dialog>, document.body);
}
function ScreenshotEditor({ file, onChange, onRemove }: { file: File; onChange(file: File): void; onRemove(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null); const start = useRef<{ x: number; y: number }>();
  useEffect(() => { let active = true; void createImageBitmap(file).then(bitmap => { if (active && canvas.current) { const element = canvas.current; element.width = bitmap.width; element.height = bitmap.height; element.getContext('2d')?.drawImage(bitmap, 0, 0); } bitmap.close(); }); return () => { active = false; }; }, [file]);
  return <div><canvas ref={canvas} aria-label="截图预览与遮盖" title="截图预览与遮盖" onPointerDown={e => { const c = e.currentTarget; const rect = c.getBoundingClientRect(); start.current = { x: (e.clientX - rect.left) * c.width / rect.width, y: (e.clientY - rect.top) * c.height / rect.height }; c.setPointerCapture(e.pointerId); }} onPointerUp={e => { if (!start.current) return; const c = e.currentTarget; const rect = c.getBoundingClientRect(); const x = (e.clientX - rect.left) * c.width / rect.width; const y = (e.clientY - rect.top) * c.height / rect.height; const ctx = c.getContext('2d'); if (ctx) { ctx.fillStyle = '#000000'; ctx.fillRect(Math.min(x, start.current.x), Math.min(y, start.current.y), Math.abs(x - start.current.x), Math.abs(y - start.current.y)); c.toBlob(blob => { if (blob) onChange(new File([blob], file.name, { type: 'image/png' })); }, 'image/png'); } start.current = undefined; }} /><button type="button" title="移除截图" aria-label="移除截图" onClick={onRemove}><Trash2 size={16} /></button></div>;
}
