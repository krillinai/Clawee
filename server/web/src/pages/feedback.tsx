import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Download, Play, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAdminPermission } from '@/components/admin-permissions';
import { DataTableShell, EmptyState, ErrorAlert, FilterRow, FilterSearchField, FilterSelect, LoadingState, PageHeader, PageShell, TableStateRow } from '@/components/governance-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { feedbackAdminApi, type FeedbackPage } from '@/lib/feedback-admin-api';
import { APIError, isForbiddenError } from '@/lib/api';
import { permissions } from '@/lib/rbac-api';
import { trimInput } from '@/lib/text';

const statuses: Record<string, string> = { open: '待处理', investigating: '处理中', resolved: '已处理', all: '全部' };
function useFocused() { const [focused, setFocused] = useState(document.hasFocus()); useEffect(() => { const update = () => setFocused(document.hasFocus() && !document.hidden); window.addEventListener('focus', update); window.addEventListener('blur', update); document.addEventListener('visibilitychange', update); return () => { window.removeEventListener('focus', update); window.removeEventListener('blur', update); document.removeEventListener('visibilitychange', update); }; }, []); return focused; }
export function FeedbackPageView() {
  const [params, setParams] = useSearchParams(); const focused = useFocused();
  const query = useQuery({ queryKey: ['feedback-list', params.toString()], queryFn: () => feedbackAdminApi.list(params), refetchInterval: current => focused && !isForbiddenError(current.state.error) ? 15000 : false });
  const change = (key: string, value: string) => { const next = new URLSearchParams(params); next.delete('cursor'); if (value) next.set(key, value); else next.delete(key); setParams(next); };
  const position = useRef(Number(sessionStorage.getItem(`feedback-scroll:${params}`) ?? 0));
  useEffect(() => { if (query.data) window.scrollTo(0, position.current); }, [Boolean(query.data)]);
  return (
    <PageShell>
      <PageHeader title="问题反馈" />
      <section aria-label="反馈列表" className="grid min-w-0 gap-3">
          <FilterRow compact>
            <FilterSearchField aria-label="编号或描述" placeholder="编号或描述" value={params.get('keyword') ?? ''} onChange={e => change('keyword', e.target.value)} />
            <FilterSelect ariaLabel="筛选反馈状态" value={params.get('status') ?? 'open'} onChange={value => change('status', value)}>
              {Object.entries(statuses).map(([key, text]) => <option key={key} value={key}>{key === 'all' ? '全部状态' : text}</option>)}
            </FilterSelect>
            <Input className="w-full sm:w-40" aria-label="来源" placeholder="来源" value={params.get('source') ?? ''} onChange={e => change('source', e.target.value)} />
            <Input className="w-full sm:w-40" aria-label="App 版本" placeholder="App 版本" value={params.get('version') ?? ''} onChange={e => change('version', e.target.value)} />
          </FilterRow>
          <FilterRow compact>
            {['from', 'to'].map(key => (
              <label key={key} className="grid w-full gap-1 text-xs text-muted-foreground sm:w-40">
                {key === 'from' ? '开始时间' : '结束时间'}
                <Input className="w-full" aria-label={key === 'from' ? '开始时间' : '结束时间'} type="date" value={params.get(key)?.slice(0, 10) ?? ''} onChange={e => change(key, e.target.value ? `${e.target.value}T${key === 'to' ? '23:59:59' : '00:00:00'}Z` : '')} />
              </label>
            ))}
            <label className="flex h-9 items-center gap-2 self-end text-sm">
              <Checkbox aria-label="包含异常材料" checked={params.get('include_unavailable') === 'true'} onCheckedChange={checked => change('include_unavailable', checked === true ? 'true' : '')} />
              包含异常材料
            </label>
          </FilterRow>
          <DataTableShell dense minWidth={1120}>
            <TableHeader>
              <TableRow>
                {['编号 / 描述', '来源', 'App 版本', '创建时间', '完整性', '材料状态', '状态 / 处理人', '完成时间'].map(text => <TableHead key={text}>{text}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isPending ? <TableStateRow colSpan={8}><LoadingState label="正在加载反馈" /></TableStateRow> : query.isError ? (
                <TableStateRow colSpan={8} tone="danger">
                  <ErrorAlert error={query.error}>反馈列表加载失败 <Button variant="outline" onClick={() => void query.refetch()}>重试</Button></ErrorAlert>
                </TableStateRow>
              ) : !query.data?.items.length ? (
                <TableStateRow colSpan={8}><EmptyState title="没有符合条件的反馈" /></TableStateRow>
              ) : query.data.items.map(r => (
                <TableRow key={r.report_id}>
                  <TableCell className="max-w-80">
                    <Link className="font-medium hover:underline" to={`/admin/feedback/${r.report_id}?${params}`} onClick={() => sessionStorage.setItem(`feedback-scroll:${params}`, String(window.scrollY))}>{r.display_number}</Link>
                    <p className="line-clamp-2 break-all text-muted-foreground">{r.description}</p>
                  </TableCell>
                  <TableCell className="max-w-48 break-all">{r.trusted_source ? `${r.trusted_source}（可信）` : `${r.source_claim?.customer_label ?? '匿名'}（自报）`}</TableCell>
                  <TableCell className="font-mono text-xs">{r.environment?.app_version ?? '未知'}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{new Date(r.created_at).toLocaleString()}</TableCell>
                  <TableCell><Badge variant={r.completeness === 'complete' ? 'success' : 'warning'}>{r.completeness}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{`${r.upload_state} / ${r.security_state}`}</TableCell>
                  <TableCell>
                    <Badge variant={r.processing_status === 'resolved' ? 'success' : r.processing_status === 'investigating' ? 'warning' : 'muted'}>{statuses[r.processing_status]}</Badge>
                    {r.assigned_to ? <p className="mt-1 break-all text-muted-foreground">{r.assigned_to}</p> : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{r.resolved_at ? new Date(r.resolved_at).toLocaleString() : '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTableShell>
          {query.data?.meta.has_next ? <div className="flex justify-end"><Button variant="outline" onClick={() => { const next = new URLSearchParams(params); next.set('cursor', query.data!.meta.next_cursor); setParams(next); window.scrollTo(0, 0); }}>下一页</Button></div> : null}
      </section>
    </PageShell>
  );
}
export function FeedbackDetailPage() {
  const { id = '' } = useParams(); const [params] = useSearchParams(); const focused = useFocused(); const cache = useQueryClient();
  const query = useQuery({ queryKey: ['feedback-report', id], queryFn: () => feedbackAdminApi.get(id), refetchInterval: current => focused && !isForbiddenError(current.state.error) ? 15000 : false });
  const [operation, setOperation] = useState(''); const [editingVersion, setEditingVersion] = useState(0); const [values, setValues] = useState<Record<string, string>>({}); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [image, setImage] = useState(''); const [tab, setTab] = useState('conversation');
  const canInvestigate = useAdminPermission(permissions.feedbackInvestigate); const canResolve = useAdminPermission(permissions.feedbackResolve); const canReopen = useAdminPermission(permissions.feedbackReopen); const canDownload = useAdminPermission(permissions.feedbackDownload);
  const r = query.data; const ready = r?.upload_state === 'ready' && r.security_state === 'normal' && Date.parse(r.expires_at) > Date.now();
  const submittedRequest = useRef<{ content: string; input: Record<string, unknown> } | undefined>(undefined);
  const start = (op: string) => { submittedRequest.current = undefined; setOperation(op); setEditingVersion(r!.version); setValues({}); setError(''); };
  const normalizedValues = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, trimInput(value)]));
  const content = JSON.stringify({ ...normalizedValues, expected_version: editingVersion });
  const retryingSameRequest = submittedRequest.current?.content === content;
  const submit = async () => {
    if (!r || busy) return;
    setBusy(true); setError('');
    if (submittedRequest.current?.content !== content) submittedRequest.current = { content, input: { ...normalizedValues, expected_version: editingVersion, idempotency_key: crypto.randomUUID() } };
    try {
      await feedbackAdminApi.operate(id, operation, submittedRequest.current.input);
      setOperation('');
      await cache.invalidateQueries({ queryKey: ['feedback-report', id] });
      await cache.invalidateQueries({ queryKey: ['feedback-list'] });
    } catch (e) {
      const conflict = e instanceof APIError && e.status === 409;
      if (conflict) submittedRequest.current = undefined;
      setError(conflict ? '反馈版本或状态已变更，请关闭表单并重新读取。' : isForbiddenError(e) ? e.message : '操作失败，请重试。');
    } finally { setBusy(false); }
  };
  if (query.isPending) return <p>正在加载…</p>; if (query.isError || !r) return <p role="alert">{isForbiddenError(query.error) ? query.error.message : '反馈不可用'} {!isForbiddenError(query.error) ? <Button variant="outline" onClick={() => void query.refetch()}>重试</Button> : null}</p>;
  return <main className="min-w-0 space-y-5"><Link className="inline-flex items-center gap-2" to={`/admin/feedback?${params}`}><ArrowLeft size={16} />返回列表</Link><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">{r.display_number}</h1><div className="flex flex-wrap gap-2">{ready && canInvestigate && r.processing_status === 'open' ? <Button variant="outline" onClick={() => start('investigate')}><Play size={16} />开始处理</Button> : null}{ready && canResolve && r.processing_status !== 'resolved' ? <Button onClick={() => start('resolve')}><Check size={16} />标记已处理</Button> : null}{ready && canReopen && r.processing_status === 'resolved' ? <Button variant="outline" onClick={() => start('reopen')}><RotateCcw size={16} />重新打开</Button> : null}</div></div>
    <p>{statuses[r.processing_status]} · {r.completeness} · {r.upload_state} · {r.security_state} · 版本 {r.version}</p><p className="whitespace-pre-wrap break-all">{r.description}</p>{r.reproduction_steps ? <p className="whitespace-pre-wrap break-all">{r.reproduction_steps}</p> : null}
    {!ready ? <p role="alert">材料尚未就绪、已隔离或已过期，不能读取正文与处理。</p> : null}
    <div className="flex flex-wrap gap-3">{ready ? r.artifacts?.filter(a => a.kind === 'screenshot').map(a => <button key={a.artifact_id} type="button" title="放大截图" onClick={() => setImage(feedbackAdminApi.image(id, a.artifact_id))}><img className="max-h-40 max-w-64 object-contain" src={feedbackAdminApi.image(id, a.artifact_id)} alt={a.name} onError={e => { e.currentTarget.alt = '截图缺失'; }} /></button>) : null}</div>
    {r.manifest?.missing_items.length ? <div className="break-all text-sm"><h2>缺失项</h2>{r.manifest.missing_items.map(item => <p key={item}>{item}</p>)}</div> : null}
    <Tabs value={tab} onValueChange={setTab}><TabsList>{[['conversation', '会话'], ['logs', '日志'], ['environment', '环境'], ['events', '处理记录']].map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}</TabsList><TabsContent value="conversation">{ready && tab === 'conversation' ? <FeedbackRecords id={id} kind="conversation" artifacts={[]} /> : null}</TabsContent><TabsContent value="logs">{ready && tab === 'logs' ? <FeedbackRecords id={id} kind="logs" artifacts={r.artifacts?.filter(a => ['logs', 'diagnostics'].includes(a.kind)) ?? []} /> : null}</TabsContent><TabsContent value="environment"><pre className="max-w-full overflow-auto whitespace-pre-wrap break-all text-sm">{JSON.stringify(r.environment, null, 2)}</pre><p className="text-sm">Codex 读取材料可能发送给其配置的模型服务商，由维护方按客户数据约定处理。</p></TabsContent><TabsContent value="events"><pre className="max-w-full overflow-auto whitespace-pre-wrap break-all text-sm">{JSON.stringify(r.events, null, 2)}</pre></TabsContent></Tabs>
    {ready && canDownload ? <div className="flex flex-wrap gap-3">{r.artifacts?.map(a => <a key={a.artifact_id} className="inline-flex items-center gap-1 text-sm underline" href={feedbackAdminApi.download(id, a.artifact_id)} download><Download size={14} />{a.name}</a>)}</div> : null}
    <Dialog open={Boolean(image)} onOpenChange={() => setImage('')}><DialogContent className="max-w-5xl"><DialogHeader><DialogTitle>问题截图</DialogTitle></DialogHeader><img className="max-h-[75vh] max-w-full object-contain" src={image} alt="问题截图" /></DialogContent></Dialog>
    <Dialog open={Boolean(operation)} onOpenChange={() => !busy && setOperation('')}><DialogContent><DialogHeader><DialogTitle>{operation === 'resolve' ? '标记已处理' : operation === 'reopen' ? '重新打开' : '开始处理'}</DialogTitle></DialogHeader>{operation === 'resolve' ? ['resolution_summary', 'verification', 'fix_commit', 'fixed_version', 'public_resolution_summary'].map((key, index) => <label key={key} className="grid gap-1 text-sm">{['内部处理结论（必填）', '验证方法与结果（必填）', '修复提交', '修复版本', '客户可见结论'][index]}<Textarea maxLength={index < 2 || index === 4 ? 10000 : 128} value={values[key] ?? ''} onChange={e => setValues(old => ({ ...old, [key]: e.target.value }))} /></label>) : operation === 'reopen' ? <label>重新打开原因<Textarea maxLength={10000} value={values.reason ?? ''} onChange={e => setValues({ reason: e.target.value })} /></label> : <p>处理人将记录为当前中心账号。</p>}{editingVersion !== r.version ? <p role="alert">反馈已更新，请关闭表单后重新读取。</p> : null}{error ? <p role="alert">{error}</p> : null}<Button disabled={busy || (editingVersion !== r.version && !retryingSameRequest) || (operation === 'resolve' && (!values.resolution_summary?.trim() || !values.verification?.trim())) || (operation === 'reopen' && !values.reason?.trim())} onClick={() => void submit()}>确认</Button></DialogContent></Dialog>
  </main>;
}
function FeedbackRecords({ id, kind, artifacts }: { id: string; kind: 'conversation' | 'logs'; artifacts: Array<{ artifact_id: string; name: string }> }) {
  const [aid, setAid] = useState(artifacts[0]?.artifact_id ?? ''); const [filters, setFilters] = useState<Record<string, string>>({}); const [pages, setPages] = useState<FeedbackPage[]>([]); const [cursor, setCursor] = useState('');
  const params = new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, trimInput(value)])), ...(aid ? { artifact_id: aid } : {}), cursor });
  const query = useQuery({ queryKey: ['feedback-read', id, kind, params.toString()], queryFn: () => feedbackAdminApi.read(id, kind, params) });
  useEffect(() => { if (query.data) setPages(old => cursor ? [...old, query.data] : [query.data]); }, [query.data]);
  const reset = () => { setCursor(''); setPages([]); };
  return <div className="min-w-0 space-y-3">{kind === 'logs' ? <><select className="max-w-full rounded border bg-background p-2 text-sm" aria-label="日志附件" value={aid} onChange={e => { setAid(e.target.value); reset(); }}>{artifacts.map(a => <option key={a.artifact_id} value={a.artifact_id}>{a.name}</option>)}</select><div className="flex flex-wrap gap-2">{[['keyword', '关键词'], ['level', '级别'], ['run_id', 'Run'], ['from', '开始时间'], ['to', '结束时间']].map(([key, label]) => <Input key={key} className="w-40" aria-label={label} placeholder={label} value={filters[key] ?? ''} onChange={e => { setFilters(old => ({ ...old, [key]: e.target.value })); reset(); }} />)}</div></> : null}{query.isPending ? <p>正在读取…</p> : null}{query.isError ? <p role="alert">{isForbiddenError(query.error) ? query.error.message : '材料读取失败或附件缺失'} {!isForbiddenError(query.error) ? <Button variant="outline" onClick={() => void query.refetch()}>重试</Button> : null}</p> : null}{!isForbiddenError(query.error) ? <pre className="max-h-[60vh] max-w-full overflow-auto whitespace-pre-wrap break-all text-xs">{pages.flatMap(page => page.records).map((record, index) => <span key={index}>{record.continuation || record.fragment_offset ? `[分段 ${record.fragment_offset}] ` : ''}{record.text}{'\n'}</span>)}</pre> : null}{!isForbiddenError(query.error) && query.data?.has_next ? <Button variant="outline" disabled={query.isFetching} onClick={() => setCursor(query.data!.next_cursor)}>继续读取</Button> : null}</div>;
}
