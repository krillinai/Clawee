import type { EnterpriseWorkflowDraftUpdate, EnterpriseWorkflowExecution } from '@clawee/protocol';
import { Check, Eye, LoaderCircle, Pencil, RefreshCw, Save, Upload, X } from 'lucide-react';
import { useState } from 'react';
import { MarkdownRenderer } from '../../components/markdown/MarkdownRenderer.js';

export function WorkflowDeliveryPanel({ execution, online, running, onSave, onSubmit }: {
  execution: EnterpriseWorkflowExecution;
  online: boolean;
  running: boolean;
  onSave(update: EnterpriseWorkflowDraftUpdate): Promise<void>;
  onSubmit(version: number): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [editVersion, setEditVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const delivery = execution.delivery;
  if (!delivery || execution.status === 'completed') return null;
  const disabled = !online || busy || delivery.locked || execution.status === 'conflict';
  const generating = running || ['running', 'queued', 'starting'].includes(execution.runStatus ?? '');

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : '操作失败，请重试'); }
    finally { setBusy(false); }
  }

  return <section className="workflow-delivery" aria-label="节点交付结果">
    <div className="workflow-delivery-heading">
      <strong>{execution.status === 'conflict' ? '节点状态已变化' : execution.status === 'submitting' ? '正在提交节点' : execution.status === 'submit_failed' ? '提交未确认' : generating ? '正在生成回复' : '待人工确认'}</strong>
      <div className="workflow-delivery-tools">
        <button type="button" className="inline-action" disabled={disabled || generating || !delivery.latestText || editing} title="使用最新回复" aria-label="使用最新回复" onClick={() => void perform(() => onSave({ version: delivery.version, useLatest: true }))}><RefreshCw size={15} aria-hidden="true" /></button>
        <button type="button" className="inline-action" disabled={disabled || editing} title="编辑交付结果" aria-label="编辑交付结果" onClick={() => { setText(delivery.text); setEditVersion(delivery.version); setEditing(true); setError(''); }}><Pencil size={15} aria-hidden="true" /></button>
      </div>
    </div>
    {editing ? <>
      <textarea aria-label="交付结果正文" value={text} rows={8} disabled={busy || delivery.locked} onChange={event => setText(event.target.value)} />
      <div className="workflow-delivery-actions">
        <button type="button" className="inline-action" disabled={disabled} onClick={() => void perform(async () => { await onSave({ version: editVersion, text }); setEditing(false); })}><Save size={15} aria-hidden="true" />保存修改</button>
        <button type="button" className="inline-action" disabled={busy} onClick={() => { setEditing(false); setError(''); }}><X size={15} aria-hidden="true" />取消</button>
      </div>
    </> : <details className="workflow-delivery-preview">
      <summary><Eye size={15} aria-hidden="true" />交付结果{delivery.edited ? ' · 已人工修改' : ''}</summary>
      <MarkdownRenderer text={delivery.text} variant="document" />
    </details>}
    {delivery.files.length > 0 && <ul className="workflow-delivery-files">{delivery.files.map(file => <li key={file.path}>
      <label><input type="checkbox" checked={file.selected} disabled={disabled || editing} onChange={event => {
        const selectedPaths = delivery.files.filter(item => item.path === file.path ? event.target.checked : item.selected).map(item => item.path);
        void perform(() => onSave({ version: delivery.version, selectedPaths }));
      }} /><span title={file.path}>{file.name}</span><small>{Math.ceil(file.sizeBytes / 1024)} KB</small></label>
    </li>)}</ul>}
    {execution.status === 'submit_failed' && <p role="status">上次提交尚未确认，结果已锁定，可使用原内容重试。</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="workflow-delivery-actions">
      <button type="button" className="inline-action workflow-delivery-submit" disabled={!online || busy || generating || editing || execution.status === 'submitting' || execution.status === 'conflict' || (!delivery.sourceRunId && !delivery.edited) || (!delivery.text.trim() && !delivery.files.some(file => file.selected))} onClick={() => void perform(() => onSubmit(delivery.version))}>
        {busy || execution.status === 'submitting' ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : execution.status === 'submit_failed' ? <RefreshCw size={15} aria-hidden="true" /> : <Upload size={15} aria-hidden="true" />}
        {execution.status === 'submit_failed' ? '重试完成节点并上传结果' : '完成节点并上传结果'}
      </button>
      {delivery.edited && !editing && <span className="workflow-delivery-saved"><Check size={14} aria-hidden="true" />已保存</span>}
    </div>
  </section>;
}
