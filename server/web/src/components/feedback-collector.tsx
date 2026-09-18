import { Bug, Download, Paintbrush, Send, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { adminApi, APIError } from '@/lib/api';
import { feedbackDiagnosticsSnapshot, feedbackRandomToken, redactConsoleText } from '@/lib/feedback-diagnostics';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FeedbackScreenshotEditor } from './feedback-screenshot-editor';

type Snapshot = ReturnType<typeof feedbackDiagnosticsSnapshot> & {
  client_feedback_id: string; recovery_token: string; status_token: string;
  description: string; occurred_at: string; reproduction_steps: string; snapshot_at: string;
  confirmed_at?: string;
  page: string; user_agent: string; language: string;
};
type Receipt = { report_id: string; display_number: string; upload_state: string; security_state: string };

function download(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FeedbackCollector() {
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [occurred, setOccurred] = useState('');
  const [screenshots, setScreenshots] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [editingScreenshot, setEditingScreenshot] = useState<number>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [confirmed, setConfirmed] = useState(false);
  const [partial, setPartial] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<Receipt>();
  const [terminal, setTerminal] = useState(false);
  useEffect(() => {
    const urls = screenshots.map(file => URL.createObjectURL(file)); setPreviews(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [screenshots]);
  async function checkPolicy() {
    setAllowed(null); setError('');
    try { const policy = await adminApi.get<{ external_feedback_allowed: boolean }>('/feedback/collection-policy'); setAllowed(policy.external_feedback_allowed === true); }
    catch { setError('无法读取反馈策略，请重试。'); }
  }
  function prepare() {
    if (allowed !== true || editingScreenshot !== undefined || !description.trim()) return;
    const at = occurred ? new Date(occurred) : new Date();
    if (!Number.isFinite(at.getTime())) { setError('发生时间无效。'); return; }
    setSnapshot({ ...feedbackDiagnosticsSnapshot(), client_feedback_id: `admin_${feedbackRandomToken()}`, recovery_token: feedbackRandomToken(), status_token: feedbackRandomToken(), description: redactConsoleText(description), occurred_at: at.toISOString(), reproduction_steps: redactConsoleText(steps), snapshot_at: new Date().toISOString(), page: location.pathname, user_agent: navigator.userAgent, language: navigator.language });
    setConfirmed(false); setPartial(false); setError('');
  }
  function addScreenshots(files: File[]) {
    if (screenshots.length + files.length > 5 || files.some(file => file.size > 10 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) { setError('截图仅支持 PNG、JPEG、WebP，最多 5 张，每张不超过 10 MiB。'); return; }
    setScreenshots(old => [...old, ...files]); setError('');
  }
  async function send() {
    if (!snapshot || busy || terminal || !confirmed || !partial || allowed !== true) return;
    setBusy(true); setAttempted(true); setError('');
    const authorisedSnapshot = snapshot.confirmed_at ? snapshot : { ...snapshot, confirmed_at: new Date().toISOString() };
    setSnapshot(authorisedSnapshot);
    const form = new FormData(); form.set('metadata', JSON.stringify({ ...authorisedSnapshot, confirmed: true, accept_partial: true }));
    screenshots.forEach((file, index) => form.append('screenshots', file, `screenshot-${index + 1}`));
    try { setReceipt(await adminApi.postForm<Receipt>('/feedback/collect', form)); }
    catch (e) {
      if (e instanceof APIError && e.code === 'feedback_policy_disabled') { setAllowed(false); setError('企业策略已禁止外部反馈。'); }
      else if (e instanceof APIError && [400, 409, 410, 413].includes(e.status)) { setTerminal(true); setError(e.status === 410 ? '反馈已过期，请新建反馈。' : '资料无效、超限或快照冲突，请检查资料后新建反馈。'); }
      else { setError('发送未完成，资料已保留，可重试同一份反馈。'); }
    }
    finally { setBusy(false); }
  }
  function reset() { setSnapshot(undefined); setReceipt(undefined); setDescription(''); setSteps(''); setOccurred(''); setScreenshots([]); setEditingScreenshot(undefined); setConfirmed(false); setPartial(false); setAttempted(false); setTerminal(false); setError(''); }
  function exportSnapshot() {
    if (!snapshot) return;
    const { recovery_token: _recovery, status_token: _status, ...publicSnapshot } = snapshot;
    download(new Blob([JSON.stringify({ ...publicSnapshot, completeness: 'partial', missing_items: ['conversation:unavailable', 'desktop:unavailable', 'gateway_logs:not_collected', 'browser:current_session_only'], screenshot_count: screenshots.length }, null, 2)], { type: 'application/json' }), 'admin-feedback.json');
  }
  const publicPreview = snapshot ? { description: snapshot.description, reproduction_steps: snapshot.reproduction_steps, occurred_at: snapshot.occurred_at, page: snapshot.page, user_agent: snapshot.user_agent, language: snapshot.language, errors: snapshot.errors, dropped_errors: snapshot.dropped_errors } : undefined;
  const sizeBytes = (publicPreview ? new TextEncoder().encode(JSON.stringify(publicPreview)).length : 0) + screenshots.reduce((size, file) => size + file.size, 0);
  return <>
    <Button className="w-full justify-start" size="sm" variant="ghost" onClick={() => { setOpen(true); void checkPolicy(); }}><Bug size={16} />提交异常反馈</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-xl" onPaste={event => { if (!snapshot) { const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); addScreenshots(files); } } }}>
        <DialogHeader><DialogTitle>提交管理后台异常反馈</DialogTitle><DialogDescription>将描述、截图及当前浏览器异常记录发送给 Clawee 软件维护方 gateway.clawee.work。资料可能包含业务内容。</DialogDescription></DialogHeader>
        {allowed === false ? <p role="alert">企业策略已禁止外部反馈。</p> : null}
        {allowed === null ? <p>正在读取反馈策略…</p> : null}
        {receipt ? <div className="space-y-3"><p role="status">反馈已提交：{receipt.display_number || receipt.report_id}</p>{receipt.security_state === 'quarantine' ? <p>材料已隔离，等待维护方安全检查。</p> : null}<Button variant="outline" onClick={reset}>新建反馈</Button></div> : <>
          <label className="grid gap-1 text-sm">问题描述（必填）<Textarea maxLength={10000} disabled={Boolean(snapshot)} value={description} onChange={e => setDescription(e.target.value)} /></label>
          <label className="grid gap-1 text-sm">发生时间<Input type="datetime-local" disabled={Boolean(snapshot)} value={occurred} onChange={e => setOccurred(e.target.value)} /></label>
          <label className="grid gap-1 text-sm">复现步骤<Textarea maxLength={10000} disabled={Boolean(snapshot)} value={steps} onChange={e => setSteps(e.target.value)} /></label>
          {!snapshot ? <label className="grid gap-1 text-sm">截图<Input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => { addScreenshots(Array.from(e.target.files ?? [])); e.target.value = ''; }} /></label> : null}
          <div className="grid grid-cols-2 gap-2">{screenshots.map((file, index) => <div className="min-w-0" key={index}><img className="aspect-video w-full object-contain" src={previews[index]} alt={`截图 ${index + 1}`} /><div className="flex items-center justify-between"><span className="text-xs">截图 {index + 1}</span>{snapshot ? <Button title="下载截图" aria-label={`下载截图 ${index + 1}`} variant="ghost" size="icon" onClick={() => download(file, `screenshot-${index + 1}.${file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1]}`)}><Download size={16} /></Button> : <div className="flex"><Button title="遮盖截图" aria-label={`遮盖截图 ${index + 1}`} variant="ghost" size="icon" disabled={editingScreenshot !== undefined} onClick={() => setEditingScreenshot(index)}><Paintbrush size={16} /></Button><Button title="移除截图" aria-label={`移除截图 ${index + 1}`} variant="ghost" size="icon" disabled={editingScreenshot !== undefined} onClick={() => setScreenshots(old => old.filter((_, i) => i !== index))}><Trash2 size={16} /></Button></div>}</div></div>)}</div>
          {editingScreenshot !== undefined && screenshots[editingScreenshot] ? <FeedbackScreenshotEditor file={screenshots[editingScreenshot]} onCancel={() => setEditingScreenshot(undefined)} onSave={file => { setScreenshots(old => old.map((original, index) => index === editingScreenshot ? file : original)); setEditingScreenshot(undefined); }} /> : null}
          {snapshot ? <>
            <div className="min-w-0 space-y-2 text-sm"><p>部分资料 · 浏览器异常 {snapshot.errors.length} 条 · 截图 {screenshots.length} 张</p><p>本地材料约 {(sizeBytes / 1024).toFixed(1)} KiB</p><p>材料清单：页面环境、浏览器诊断、异常记录及截图</p><p>缺失：会话、桌面及服务器日志；仅包含当前管理会话的浏览器记录{snapshot.dropped_errors ? `，${snapshot.dropped_errors} 条记录或正文已截断` : ''}。</p><pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(publicPreview, null, 2)}</pre></div>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />确认可以发送上述资料和截图给软件维护方</label>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={partial} disabled={busy} onChange={e => setPartial(e.target.checked)} />确认按部分资料发送，不包含桌面、会话及服务器日志</label>
            {attempted ? <p className="text-xs text-muted-foreground">中心可能已收到部分材料，未提交材料将限时回收。</p> : null}
            <div className="flex flex-wrap gap-2"><Button disabled={busy || terminal || allowed !== true || !confirmed || !partial} onClick={() => void send()}><Send size={16} />{busy ? '正在发送…' : attempted ? '重试发送' : '发送反馈'}</Button>{!attempted ? <Button variant="outline" onClick={() => setSnapshot(undefined)}>修改资料</Button> : <Button variant="outline" disabled={busy} onClick={reset}>新建反馈</Button>}<Button variant="outline" onClick={exportSnapshot}><Download size={16} />本地导出</Button></div>
          </> : <Button disabled={allowed !== true || editingScreenshot !== undefined || !description.trim()} onClick={prepare}>准备反馈</Button>}
        </>}
        {error ? <div role="alert" className="text-sm"><p>{error}</p>{allowed === null ? <Button variant="outline" onClick={() => void checkPolicy()}>重试读取策略</Button> : null}</div> : null}
      </DialogContent>
    </Dialog>
  </>;
}
