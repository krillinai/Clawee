import type { EnterpriseApprovalDetail, EnterpriseApprovalFile, EnterpriseApprovalFilters, EnterpriseApprovalItem, EnterpriseApprovalKind, EnterpriseApprovalPage, EnterpriseReviewScores } from '@clawee/protocol';
import { ArrowLeft, ChevronDown, ClipboardCheck, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from '../../components/markdown/MarkdownRenderer.js';
import { ApiClientError } from '../../runtime/client.js';
import type { EnterpriseApprovalService } from '../../services/enterprise-approval-service.js';
import { SkillUseProjectDialog, type SkillMarketProjectOption } from '../plugins/SkillUseProjectDialog.js';
import { WorkflowSteps } from '../workflow/WorkflowPage.js';
import { createWorkflowRequestId } from '../workflow/request-id.js';
import './enterprise-approvals.css';

const labels: Record<string, string> = {
  pending: '待审核', approved: '已通过', rejected: '已驳回', invalidated: '已失效', running: '运行中', succeeded: '已完成', terminated: '已终止',
  ai_pending: '待 AI 评估', ai_running: 'AI 评估中', revision_required: '需修改', ai_failed: '评估执行异常', human_pending: '待人工审核'
};
const personalLabels = { pending: '待我处理', approved: '我已通过', rejected: '我已驳回', '': '未处理' };
const dimensions = [
  { key: 'scenario_value', label: '场景价值' }, { key: 'result_effectiveness', label: '结果有效' },
  { key: 'ease_of_use', label: '使用友好' }, { key: 'reuse_value', label: '复用价值' }
] as const;
const dateText = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';
const statusText = (item: EnterpriseApprovalItem) => labels[item.workflow_stage ?? ''] ?? labels[item.business_status] ?? item.business_status;
function errorText(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return '登录已失效，请重新登录企业账户';
    if (error.status === 403) return '暂无审批权限，请联系管理员';
    if (error.status === 404) return '审批记录不可见或已不存在，请刷新列表';
    if (error.status === 409) return '审批状态已变化，请刷新后查看当前结果';
  }
  return error instanceof Error ? error.message : '审批请求失败，请稍后重试';
}
type Target = { kind: EnterpriseApprovalKind; id: string };
export type ApprovalNavigationState = { filters: EnterpriseApprovalFilters; cursors: string[]; selected?: Target };
type Props = {
  service: EnterpriseApprovalService | null; signedIn: boolean; online: boolean; identityKey: string;
  onOpenAccount(): void; navigationState?: ApprovalNavigationState; onNavigationChange(state: ApprovalNavigationState): void;
  projects?: readonly SkillMarketProjectOption[]; currentProjectId?: string;
  onTrial?(requestId: string, projectId: string): Promise<void>;
};

export function EnterpriseApprovalsPage(props: Props) {
  if (!props.signedIn || !props.online || !props.service) return <main className="workflow-page enterprise-approvals-page">
    <header className="workflow-header"><h1>审批中心</h1></header>
    <p className="workflow-muted" role="status">{!props.signedIn ? '登录企业账户后查看审核待办和进展' : '企业服务尚未连接，请连接后重试'}</p>
    {!props.signedIn && <button className="inline-action" type="button" onClick={props.onOpenAccount}>登录企业账户</button>}
  </main>;
  return <ApprovalList key={props.identityKey} {...props} service={props.service} />;
}

function ApprovalList({ service, navigationState, onNavigationChange, identityKey, projects, currentProjectId, onTrial }: Props & { service: EnterpriseApprovalService }) {
  const [filters, setFilters] = useState<EnterpriseApprovalFilters>(navigationState?.filters ?? { view: 'todo', type: 'all', status: 'all' });
  const [cursors, setCursors] = useState(navigationState?.cursors ?? ['']);
  const [selected, setSelected] = useState<Target | undefined>(navigationState?.selected);
  const [page, setPage] = useState<EnterpriseApprovalPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const selectionDismissed = useRef(false);
  const callbacks = useRef(onNavigationChange);
  callbacks.current = onNavigationChange;
  useEffect(() => callbacks.current({ filters, cursors, selected }), [filters, cursors, selected]);
  const cursor = cursors.at(-1) ?? '';
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void service.list({ ...filters, cursor }, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setPage(result);
        if (!selectionDismissed.current) setSelected(current => {
          if (current && result.data.some(item => item.kind === current.kind && item.id === current.id)) return current;
          const first = result.data[0];
          return first ? { kind: first.kind, id: first.id } : undefined;
        });
      }
    }).catch(error => {
      if (!controller.signal.aborted) { setPage(undefined); setError(errorText(error)); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [service, filters, cursor, revision]);
  useEffect(() => {
    const refresh = () => { if (!busy && document.visibilityState !== 'hidden') setRevision(value => value + 1); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [busy]);
  function change(next: Partial<EnterpriseApprovalFilters>) {
    selectionDismissed.current = false;
    setFilters(current => ({ ...current, ...next })); setCursors(['']); setPage(undefined); setSelected(undefined); setNotice('');
  }
  return <main className={`workflow-page enterprise-approvals-page${selected ? ' has-selection' : ''}`}>
    <header className="workflow-header"><h1>审批中心</h1><button aria-label="刷新审批中心" title="刷新审批中心" type="button" disabled={busy || loading} onClick={() => { setNotice(''); setRevision(value => value + 1); }}><RefreshCw size={16} /></button></header>
    <nav className="workflow-tabs" aria-label="审批视图">{([['todo', '待办'], ['done', '已办'], ['initiated', '我发起']] as const).map(([view, label]) => <button type="button" disabled={busy} aria-current={filters.view === view ? 'page' : undefined} key={view} onClick={() => change({ view })}>{label}</button>)}</nav>
    {notice && <p className="approval-notice" role="status">{notice}</p>}
    <div className="approval-layout">
      <section className="workflow-list approval-list" aria-label="审批列表">
        <div className="approval-filters">
          <label>类型<span className="approval-filter-select"><select disabled={busy} value={filters.type} onChange={event => change({ type: event.target.value as EnterpriseApprovalFilters['type'] })}><option value="all">全部类型</option><option value="skill">Skill 审核</option><option value="workflow">工作流审批</option></select><ChevronDown size={14} aria-hidden="true" /></span></label>
          <label>整单状态<span className="approval-filter-select"><select disabled={busy} value={filters.status} onChange={event => change({ status: event.target.value })}>{['all', 'pending', 'approved', 'rejected', 'invalidated', 'running', 'succeeded', 'terminated'].map(value => <option key={value} value={value}>{value === 'all' ? '全部状态' : labels[value]}</option>)}</select><ChevronDown size={14} aria-hidden="true" /></span></label>
        </div>
        {error && <p className="workflow-error" role="alert">{error}</p>}
        {loading ? <p className="workflow-muted" role="status">正在加载审批记录…</p> : page?.data.map(item => <button type="button" disabled={busy} key={`${item.kind}:${item.id}`} className={`approval-row${selected?.id === item.id && selected.kind === item.kind ? ' selected' : ''}`} aria-pressed={selected?.id === item.id && selected.kind === item.kind} onClick={() => { selectionDismissed.current = false; setSelected({ kind: item.kind, id: item.id }); setNotice(''); }}>
          <strong>{item.title}{item.version ? ` · v${item.version}` : ''}</strong>
          <small><ClipboardCheck size={13} aria-hidden="true" />{item.type === 'skill' ? 'Skill 审核' : '工作流审批'}<span>{statusText(item)}</span></small>
          <small>{personalLabels[item.my_status]} · {dateText(item.acted_at || item.created_at)}</small>
        </button>)}
        {!loading && !error && !page?.data.length && <p className="workflow-muted" role="status">{filters.view === 'todo' ? '暂无审核待办' : '暂无审批记录'}</p>}
        <div className="approval-pagination"><button disabled={busy || loading || cursors.length === 1} type="button" onClick={() => { selectionDismissed.current = false; setCursors(current => current.slice(0, -1)); setSelected(undefined); }}>上一页</button><small>第 {cursors.length} 页</small><button disabled={busy || loading || !page?.meta.has_next || !page.meta.next_cursor} type="button" onClick={() => { selectionDismissed.current = false; setCursors(current => [...current, page!.meta.next_cursor]); setSelected(undefined); }}>下一页</button></div>
      </section>
      <section className="workflow-detail approval-detail" aria-label="审批详情">
        {selected ? <><button className="approval-back" type="button" disabled={busy} onClick={() => { selectionDismissed.current = true; setSelected(undefined); }}><ArrowLeft size={15} />返回列表</button><ApprovalDetail key={`${selected.kind}:${selected.id}`} target={selected} service={service} revision={revision} identityKey={identityKey} projects={projects ?? []} currentProjectId={currentProjectId} onTrial={onTrial} onBusy={setBusy} onSubmitted={() => { setNotice('审批已提交，可在已办中继续跟进'); setRevision(value => value + 1); }} /></> : <p className="workflow-muted">选择一条审批查看内容与进展</p>}
      </section>
    </div>
  </main>;
}

function ApprovalDetail({ target, service, revision, identityKey, projects, currentProjectId, onTrial, onBusy, onSubmitted }: {
  target: Target; service: EnterpriseApprovalService; revision: number; identityKey: string; projects: readonly SkillMarketProjectOption[]; currentProjectId?: string; onTrial?: (requestId: string, projectId: string) => Promise<void>; onBusy(value: boolean): void; onSubmitted(): void;
}) {
  const [detail, setDetail] = useState<EnterpriseApprovalDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [trialOpen, setTrialOpen] = useState(false);
  const [trialBusy, setTrialBusy] = useState(false);
  const [trialError, setTrialError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void service.detail(target.kind, target.id, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        if (result.data.item.kind !== target.kind || result.data.item.id !== target.id) throw new Error('审批记录不匹配，请刷新');
        setDetail(result.data);
      }
    }).catch(error => { if (!controller.signal.aborted) { setDetail(undefined); setError(errorText(error)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [service, target.kind, target.id, revision]);
  if (error) return <p className="workflow-error" role="alert">{error}</p>;
  if (!detail) return <p className="workflow-muted" role="status">正在加载审批详情…</p>;
  const { item, workflow, task } = detail;
  const versions = detail.skill?.versions.filter(version => version.version_id === item.version_id && version.local_approval?.request_id === item.id) ?? [];
  const version = versions.length === 1 ? versions[0] : undefined;
  const approval = version?.local_approval;
  const bound = item.kind === 'skill' ? Boolean(version) : item.kind === 'workflow' && task?.type === 'approval' && task.task_id === item.id;
  return <>
    <div className="workflow-instance-heading"><h2>{item.title}{item.version ? ` · v${item.version}` : ''}</h2><span>{statusText(item)}</span></div>
    <dl className="approval-metadata"><div><dt>我的处理</dt><dd><span className="approval-status">{personalLabels[item.my_status]}</span></dd></div><div><dt>创建时间</dt><dd>{dateText(item.created_at)}</dd></div>{item.acted_at && <div><dt>处理时间</dt><dd>{dateText(item.acted_at)}</dd></div>}</dl>
    {item.my_status === 'approved' && item.business_status === 'pending' && <p className="workflow-muted">我已通过，仍待其他审核人处理</p>}
    {version ? <>
      <section className="approval-section"><h3>版本说明</h3><p>{version.description || '暂无说明'}</p>{version.changelog && <p className="approval-prewrap">{version.changelog}</p>}</section>
      <section className="approval-section"><h3>AI 审核报告</h3>{approval?.ai_review?.report ? <><p>{({ recommend_approve: '建议通过', recommend_reject: '建议驳回', needs_attention: '需关注' } as Record<string, string>)[approval.ai_review.report.conclusion] ?? '审核结论待确认'}</p><p className="approval-prewrap">{approval.ai_review.report.summary}</p><ul>{approval.ai_review.report.findings.map((finding, index) => <li key={index}><span>{({ error: '阻断', warning: '注意', info: '说明' } as Record<string, string>)[finding.severity] ?? '说明'}：{finding.message}</span>{finding.path && <small>证据文件：{finding.path}</small>}</li>)}</ul>{approval.ai_review.report.suggested_scores && <p className="workflow-muted">AI 建议分：{dimensions.map(({ key, label }) => `${label} ${approval.ai_review!.report!.suggested_scores![key] ?? '—'}`).join(' · ')}（不计入人工评分）</p>}</> : <p className="workflow-muted">{item.workflow_stage ? statusText(item) : '暂无 AI 报告'}</p>}</section>
      {onTrial && item.business_status === 'pending' && projects.length > 0 && version.package_sha256 && <section className="approval-trial"><div><strong>试用本轮版本</strong><p>下载审核中的版本到所选项目，仅用于验证产出，不会覆盖现有 Skill。</p></div><button type="button" disabled={trialBusy} onClick={() => { setTrialError(''); setTrialOpen(true); }}>下载并试用</button></section>}
      {trialError && <p className="workflow-error" role="alert">{trialError}</p>}
      <SkillFiles requestId={item.id} service={service} />
      <section className="approval-section"><h3>人工审核记录</h3><p className="workflow-muted">已通过 {approval?.approved ?? 0} / {approval?.total ?? 0} 人</p>{approval?.score_summary && <p>正式总分：{approval.score_summary.total} / 20</p>}{approval?.approvers.map(person => <div className="approval-review-record" key={person.user_id}><strong>{person.name || person.user_id}</strong><span>{labels[person.status] ?? person.status} · {dateText(person.decided_at)}</span>{person.scores && <small>{dimensions.map(({ key, label }) => `${label} ${person.scores?.[key] ?? '未评分'}`).join(' · ')}</small>}{person.comment && <p className="approval-prewrap">{person.comment}</p>}</div>)}</section>
    </> : item.kind === 'skill' ? <p className="workflow-muted">本轮审核内容不可用，仅可查看审批状态</p> : null}
    {workflow && <section className="approval-section"><h3>流程进度与记录</h3>{workflow.started_by && <p className="workflow-muted">发起人：{workflow.user_names?.[workflow.started_by] || workflow.started_by}</p>}<WorkflowSteps nodes={workflow.nodes} tasks={workflow.tasks} current={workflow.current_node_id} userNames={workflow.user_names} instanceStatus={workflow.status} /></section>}
    {task && !workflow && <section className="approval-section"><h3>待审批内容</h3><p>{task.instruction}</p><pre>{JSON.stringify(task.input, null, 2)}</pre></section>}
    {bound && item.can_process ? <DecisionForm key={`${item.kind}:${item.id}`} item={item} service={service} identityKey={identityKey} disabled={loading || trialBusy} onBusy={onBusy} onSubmitted={onSubmitted} /> : <p className="workflow-muted">本记录仅供查看，当前无需我处理</p>}
    {trialOpen && onTrial && <SkillUseProjectDialog skillTitle={item.title} projects={projects} currentProjectId={currentProjectId ?? ''} onClose={() => { if (!trialBusy) setTrialOpen(false); }} onConfirm={projectId => { setTrialOpen(false); setTrialBusy(true); onBusy(true); void onTrial(item.id, projectId).catch(error => setTrialError(errorText(error))).finally(() => { setTrialBusy(false); onBusy(false); }); }} />}
  </>;
}

function SkillFiles({ requestId, service }: { requestId: string; service: EnterpriseApprovalService }) {
  const [files, setFiles] = useState<EnterpriseApprovalFile[]>();
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void service.files(requestId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setFiles(result.items); setPath(result.items.find(file => file.path === 'SKILL.md')?.path ?? result.items[0]?.path ?? '');
    }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); });
    return () => controller.abort();
  }, [requestId, service]);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController(); setLoading(true); setContent(''); setError('');
    void service.file(requestId, path, controller.signal).then(result => { if (!controller.signal.aborted) setContent(result.data.content); })
      .catch(error => { if (!controller.signal.aborted) setError(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, requestId, service]);
  return <section className="approval-section approval-files"><h3>本轮版本文件</h3>{error ? <p className="workflow-error" role="alert">{error}</p> : !files || loading ? <p className="workflow-muted" role="status">正在加载文件…</p> : !files.length ? <p className="workflow-muted">暂无文件</p> : <div className="approval-file-browser"><nav aria-label="审核文件" className="approval-file-list">{files.map(file => <button aria-pressed={file.path === path} className={file.path === path ? 'selected' : ''} key={file.path} type="button" onClick={() => setPath(file.path)}><span>{file.path}</span><small>{file.size} B</small></button>)}</nav><div className="approval-file-content">{loading ? <p className="workflow-muted" role="status">正在加载文件…</p> : /\.md$/i.test(path) ? <MarkdownRenderer text={content} variant="document" /> : <pre tabIndex={0}>{content}</pre>}</div></div>}</section>;
}

type Submission = { decision: 'approved' | 'rejected'; comment: string; scores: EnterpriseReviewScores; key: string };
function DecisionForm({ item, service, identityKey, disabled, onBusy, onSubmitted }: {
  item: EnterpriseApprovalItem; service: EnterpriseApprovalService; identityKey: string; disabled: boolean; onBusy(value: boolean): void; onSubmitted(): void;
}) {
  const storageKey = `enterprise-approval:${identityKey}:${item.kind}:${item.id}`;
  const [retry, setRetry] = useState<Submission | undefined>(() => {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return;
    try { return JSON.parse(raw) as Submission; } catch { sessionStorage.removeItem(storageKey); }
  });
  const [decision, setDecision] = useState<Submission['decision'] | undefined>(retry?.decision);
  const [comment, setComment] = useState(retry?.comment ?? '');
  const [scores, setScores] = useState<EnterpriseReviewScores>(retry?.scores ?? {});
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const busy = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const valid = item.kind !== 'skill' || (decision === 'rejected' ? Boolean(comment.trim()) : dimensions.every(({ key }) => scores[key] !== undefined));
  async function submit() {
    if (!decision || !valid || busy.current || disabled || blocked) return;
    busy.current = true; setPending(true); setError(''); onBusy(true);
    try {
      const input = retry ?? { decision, comment: comment.trim(), scores, key: createWorkflowRequestId() };
      sessionStorage.setItem(storageKey, JSON.stringify(input)); setRetry(input);
      if (item.kind === 'skill') await service.skillDecision(item.id, { decision: input.decision, comment: input.comment, scores: input.scores });
      else await service.workflowDecision(item.id, input.decision === 'approved' ? 'approve' : 'reject', input.comment, input.key);
      sessionStorage.removeItem(storageKey);
      if (active.current) { setSubmitted(true); onSubmitted(); }
    } catch (error) {
      if (!active.current) return;
      setError(errorText(error));
      if (error instanceof ApiClientError && [401, 403, 404, 409].includes(error.status)) { setBlocked(true); sessionStorage.removeItem(storageKey); }
    } finally {
      if (active.current) { busy.current = false; setPending(false); onBusy(false); }
    }
  }
  if (submitted) return <p className="approval-notice" role="status">本次审批已提交</p>;
  return <section className="approval-decision" aria-label="处理审批">
    {!decision ? <div className="approval-decision-buttons"><button className="approval-approve" type="button" disabled={disabled} onClick={() => setDecision('approved')}>通过</button><button className="approval-reject" type="button" disabled={disabled} onClick={() => setDecision('rejected')}>驳回</button></div> : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h3>{decision === 'approved' ? '通过审核' : '驳回审核'}</h3>
      {item.kind === 'skill' && <><p className="workflow-muted">各项 1–5 分，通过时四项必填；驳回时意见必填，评分可选。</p><div className="approval-scores">{dimensions.map(({ key, label }) => <label key={key}>{label}<select required={decision === 'approved'} disabled={pending || Boolean(retry) || disabled || blocked} value={scores[key] ?? ''} onChange={event => setScores(current => ({ ...current, [key]: event.target.value ? Number(event.target.value) : undefined }))}><option value="">未评分</option>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} 分</option>)}</select></label>)}</div></>}
      <label>审批意见<textarea required={item.kind === 'skill' && decision === 'rejected'} maxLength={item.kind === 'skill' ? 2000 : 4096} disabled={pending || Boolean(retry) || disabled || blocked} value={comment} onChange={event => setComment(event.target.value)} rows={3} /></label>
      {retry && !blocked && <p className="workflow-muted">上次提交尚未确认，重试将沿用原决定和意见</p>}
      {error && <p className="workflow-error" role="alert">{error}</p>}
      <div className="approval-decision-buttons">{!retry && <button className="approval-cancel" type="button" disabled={pending} onClick={() => { setDecision(undefined); setError(''); }}>取消</button>}<button className={decision === 'approved' ? 'approval-approve' : 'approval-reject'} type="submit" disabled={pending || disabled || blocked || !valid}>{pending ? '提交中…' : retry ? '重试原提交' : decision === 'approved' ? '确认通过' : '确认驳回'}</button></div>
    </form>}
  </section>;
}
