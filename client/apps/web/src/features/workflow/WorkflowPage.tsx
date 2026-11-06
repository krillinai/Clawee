import { workflowNodeCandidates, workflowTaskCandidates } from '@clawee/protocol';
import { ArrowRight, ChevronDown, ClipboardCheck, Download, Eye, File, FileText, Play, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MarkdownRenderer } from '../../components/markdown/MarkdownRenderer.js';
import type { createScheduleService } from '../../services/schedule-service.js';
import type { Instance, Node, Task, Template, WorkflowService } from '../../services/workflow-service.js';
import type { ClaweeProject } from '../projects/project-model.js';
import { createWorkflowRequestId } from './request-id.js';
import { WorkflowSchedules } from './WorkflowSchedules.js';
import './workflow.css';

// Instances carry no name of their own: use the template name, then the first node title.
function instanceName(instance: Instance, templateNames: Record<string, string>): string {
  return templateNames[instance.template_id]
    || instance.nodes[0]?.title
    || `流程任务 ${shortId(instance.id)}`;
}

function shortId(id: string): string {
  return id.slice(-8);
}

function workflowArtifactPreviewURL(fileId: string): string {
  return `/enterprise/shared-files/${encodeURIComponent(fileId)}/preview`;
}

const labels: Record<string, string> = { running: '运行中', succeeded: '已完成', rejected: '已驳回', terminated: '已终止', pending: '待处理', completed: '已完成', cancelled: '已取消' };
const executionLabels: Record<string, string> = { idle: 'Agent 任务尚未启动', pending: '等待执行状态更新', awaiting_confirmation: '待人工确认', submitting: '正在提交节点结果', submit_failed: '提交未确认，请进入会话重试', uploading: '历史附件上传待恢复', legacy_pending: '历史执行记录待确认', queued: '等待执行', running: 'Agent 正在执行', succeeded: '待人工确认', completed: '节点已完成', failed: '执行失败，节点未完成，可继续处理', canceled: '执行已取消，节点未完成，可继续处理', conflict: '任务状态已变化，请刷新' };
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败';
const textValue = (value?: Record<string, unknown>) => typeof value?.text === 'string' ? value.text : '';
type View = 'templates' | 'instances' | 'tasks';

export type WorkflowTaskContext = {
  instanceId: string;
  workflowName: string;
  nodeTitle: string;
  nodeOrder: number;
};

export type WorkflowNavigationState = {
  tab: View | 'schedules';
  status: string;
  taskFilter: 'all' | Task['type'];
  instanceId?: string;
  cursors: Record<View, string>;
  history: Record<View, string[]>;
};

function nodeExecutionLabel(status?: string): string {
  if (!status || status === 'idle') return '待执行';
  if (status === 'failed') return '执行失败';
  if (status === 'canceled') return '执行已取消';
  return executionLabels[status] ?? '执行状态待更新';
}

export function WorkflowPage(props: Parameters<typeof WorkflowPageContent>[0]) {
  if (props.service && props.signedIn && props.identityStatus && props.identityStatus !== 'ready') {
    return <main className="workflow-page"><header className="workflow-header"><h1>工作流</h1>{props.onOpenModelSettings && <button type="button" onClick={props.onOpenModelSettings}>返回模型设置</button>}</header><p className="workflow-muted" role="status">{!props.online ? '本地 Runtime 未连接，工作流身份不可用' : props.identityStatus === 'confirming' ? '正在确认工作流身份，请稍候' : '工作流身份不可用，请检查企业连接或重新登录'}</p></main>;
  }
  return <WorkflowPageContent key={JSON.stringify([props.signedIn, props.userId, props.identityKey])} {...props} />;
}

function WorkflowPageContent({ service, scheduleService, identityKey, signedIn, online, modelReady = true, onOpenModelSettings, userId, projectId, projects = [], onSelectProject, navigationState, onNavigationChange, onTaskPrepared }: {
  service: WorkflowService | null;
  scheduleService?: ReturnType<typeof createScheduleService> | null;
  identityKey?: string;
  identityStatus?: 'ready' | 'confirming' | 'unavailable';
  signedIn: boolean;
  online: boolean;
  modelReady?: boolean;
  onOpenModelSettings?(): void;
  userId?: string;
  projectId?: string;
  projects?: ClaweeProject[];
  modelLabel?: string;
  onSelectProject?(projectId: string): void;
  navigationState?: WorkflowNavigationState;
  onNavigationChange?(state: WorkflowNavigationState): void;
  onTaskPrepared?(taskId: string, draft: { threadId: string; instruction: string; input: string; firstNode: boolean; customInput: string; resuming?: boolean; context?: WorkflowTaskContext }): void;
}) {
  const [tab, setTab] = useState<View | 'schedules'>(navigationState?.tab ?? 'tasks');
  const [scheduleTemplate, setScheduleTemplate] = useState<Template | null>(null);
  const active = useRef(true);
  const ownerKey = identityKey ? `${identityKey}:${userId}` : userId;
  const [status, setStatus] = useState(navigationState?.status ?? 'running');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateNames, setTemplateNames] = useState<Record<string, string>>({});
  const [instances, setInstances] = useState<Instance[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskFilter, setTaskFilter] = useState<'all' | Task['type']>(navigationState?.taskFilter ?? 'all');
  const [selected, setSelected] = useState<Instance | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [input, setInput] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [comment, setComment] = useState('');
  const [retryDecision, setRetryDecision] = useState<'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [canExecute, setCanExecute] = useState(false);
  const [execution, setExecution] = useState<Record<string, string>>({});
  const [cursors, setCursors] = useState<Record<View, string>>(navigationState?.cursors ?? { templates: '', instances: '', tasks: '' });
  const [nextCursors, setNextCursors] = useState<Record<View, string>>({ templates: '', instances: '', tasks: '' });
  const [history, setHistory] = useState<Record<View, string[]>>(navigationState?.history ?? { templates: [], instances: [], tasks: [] });
  const restoreInstanceId = useRef(navigationState?.instanceId);
  const selectionRequest = useRef({ generation: 0, pending: false });
  const listRequest = useRef(0);
  const listKey = JSON.stringify([status, cursors.templates, cursors.instances, cursors.tasks]);
  const [loadedListKey, setLoadedListKey] = useState<string>();
  const navigationChangeRef = useRef(onNavigationChange);
  navigationChangeRef.current = onNavigationChange;

  useEffect(() => {
    navigationChangeRef.current?.({ tab, status, taskFilter, instanceId: selected?.id ?? restoreInstanceId.current, cursors, history });
  }, [tab, status, taskFilter, selected?.id, cursors, history]);

  useEffect(() => {
    if (!service || !online || !signedIn || !restoreInstanceId.current) return;
    const id = restoreInstanceId.current;
    restoreInstanceId.current = undefined;
    void openInstance(id);
  }, [service, online, signedIn]);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  function changePage(view: View, next: string) {
    clearSelection(view);
    setHistory(previous => ({ ...previous, [view]: [...previous[view], cursors[view]] }));
    setCursors(previous => ({ ...previous, [view]: next }));
  }

  function previousPage(view: View) {
    clearSelection(view);
    const pages = history[view];
    setCursors(previous => ({ ...previous, [view]: pages.at(-1) ?? '' }));
    setHistory(previous => ({ ...previous, [view]: previous[view].slice(0, -1) }));
  }

  function clearSelection(view: View) {
    selectionRequest.current = { generation: selectionRequest.current.generation + 1, pending: false };
    if (view === 'templates') setTemplate(null);
    else setSelected(null);
  }

  async function refresh() {
    if (!service || !online || !signedIn || !active.current) return;
    const request = ++listRequest.current;
    const selectionGeneration = selectionRequest.current.generation;
    try {
      const [templateList, instanceList, taskList, capability] = await Promise.all([
        service.templates(cursors.templates), service.instances(status, cursors.instances), service.tasks(cursors.tasks), service.capability()
      ]);
      if (!active.current || request !== listRequest.current) return;
      setTemplates(templateList.data);
      setTemplateNames(previous => ({ ...previous, ...Object.fromEntries(templateList.data.map(item => [item.id, item.name])) }));
      setInstances(instanceList.data);
      setTasks(taskList.data);
      setNextCursors({ templates: templateList.meta.next_cursor, instances: instanceList.meta.next_cursor, tasks: taskList.meta.next_cursor });
      setCanExecute(capability.canExecute);
      setLoadedListKey(listKey);
      if (selected && selectionGeneration === selectionRequest.current.generation) {
        const detail = await service.instance(selected.id);
        if (!active.current || request !== listRequest.current || selectionGeneration !== selectionRequest.current.generation) return;
        setSelected(detail.data);
      }
      setError(previous => selected ? '' : previous);
    } catch (err) {
      if (!active.current || request !== listRequest.current || selectionGeneration !== selectionRequest.current.generation) return;
      setLoadedListKey(undefined); setSelected(null); setError(errorText(err));
    }
  }

  useEffect(() => {
    if (!online || !signedIn) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [service, signedIn, online, status, cursors.templates, cursors.instances, cursors.tasks, selected?.id]);

  useEffect(() => {
    if (!service || !online || !signedIn || loadedListKey !== listKey || selectionRequest.current.pending) return;
    if (tab === 'templates' && !template && templates[0]) void openTemplate(templates[0].id);
    if (tab === 'instances' && !selected && instances[0]) void openInstance(instances[0].id);
    if (tab === 'tasks' && !selected) {
      const first = tasks.find(item => taskFilter === 'all' || item.type === taskFilter);
      if (first) void openInstance(first.instance_id);
    }
  }, [service, online, signedIn, tab, taskFilter, loadedListKey, listKey, templates, instances, tasks, template?.id, selected?.id]);

  useEffect(() => {
    if (!service || !online || !selected) return;
    const current = selected.tasks?.find(task => task.status === 'pending' && task.type === 'agent' && Boolean(userId && workflowTaskCandidates(task).includes(userId)));
    if (!current) return;
    let active = true;
    const check = async () => {
      try { const result = await service.execution(current.task_id); if (active) setExecution(previous => ({ ...previous, [current.task_id]: result.status === 'pending' ? result.runStatus ?? result.status : result.status })); }
      catch { /* Workflow status is refreshed separately. */ }
    };
    void check(); const timer = window.setInterval(() => void check(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [service, online, selected?.id, selected?.current_node_id, selected?.tasks, userId]);

  useEffect(() => {
    if (!template || !userId) return;
    const saved = sessionStorage.getItem(`workflow:start:${ownerKey}:${template.id}:input`);
    setInput(saved === null ? '' : textValue(JSON.parse(saved) as Record<string, unknown>));
  }, [template?.id, userId]);

  useEffect(() => { setCustomInput(''); }, [selected?.id, selected?.current_node_id]);

  useEffect(() => {
    if (!selected || !userId) { setRetryDecision(null); return; }
    const task = selected.tasks?.find(item => item.status === 'pending' && item.type === 'approval' && Boolean(userId && workflowTaskCandidates(item).includes(userId)));
    const saved = task && sessionStorage.getItem(`workflow:decision:${ownerKey}:${task.task_id}:decision`);
    if (!saved) { setRetryDecision(null); return; }
    const value = JSON.parse(saved) as { decision: 'approve' | 'reject'; comment: string };
    setRetryDecision(value.decision); setComment(value.comment);
  }, [selected?.id, selected?.current_node_id, selected?.tasks, userId]);

  async function openTemplate(id: string) {
    if (!service || !active.current) return;
    if (!online) {
      setTemplate(templates.find(item => item.id === id) ?? null);
      return;
    }
    const generation = ++selectionRequest.current.generation;
    selectionRequest.current.pending = true;
    try { const result = await service.template(id); if (!active.current || generation !== selectionRequest.current.generation) return; setTemplate(result.data); setTemplateNames(previous => ({ ...previous, [result.data.id]: result.data.name })); setError(''); }
    catch (err) { if (active.current && generation === selectionRequest.current.generation) setError(errorText(err)); }
    finally { if (generation === selectionRequest.current.generation) selectionRequest.current.pending = false; }
  }
  async function openInstance(id: string) {
    if (!service || !online || !active.current) return;
    const generation = ++selectionRequest.current.generation;
    selectionRequest.current.pending = true;
    try { const result = await service.instance(id); if (!active.current || generation !== selectionRequest.current.generation) return; setSelected(result.data); setTemplate(null); setError(''); }
    catch (err) { if (active.current && generation === selectionRequest.current.generation) { setSelected(null); setError(errorText(err)); } }
    finally { if (generation === selectionRequest.current.generation) selectionRequest.current.pending = false; }
  }
  async function start() {
    if (!service || !online || !template || busy || !active.current) return;
    const initialInput = { text: input };
    setBusy(true); setError('');
    try {
      const keyName = `workflow:start:${ownerKey}:${template.id}`;
      const key = sessionStorage.getItem(keyName) ?? createWorkflowRequestId();
      const payloadName = `${keyName}:input`;
      const savedInput = sessionStorage.getItem(payloadName);
      sessionStorage.setItem(keyName, key);
      if (savedInput === null) sessionStorage.setItem(payloadName, JSON.stringify(initialInput));
      const result = await service.start(template.id, savedInput ? JSON.parse(savedInput) as Record<string, unknown> : initialInput, key);
      if (!active.current) return;
      sessionStorage.removeItem(keyName); sessionStorage.removeItem(payloadName);
      await refresh(); await openInstance(result.data.instance_id); setTab('instances');
    }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  async function decide(task: Task, decision: 'approve' | 'reject') {
    if (!service || !online || busy || !active.current) return;
    setBusy(true); setError('');
    try {
      const keyName = `workflow:decision:${ownerKey}:${task.task_id}`;
      const key = sessionStorage.getItem(keyName) ?? createWorkflowRequestId();
      const payloadName = `${keyName}:decision`;
      const saved = sessionStorage.getItem(payloadName);
      sessionStorage.setItem(keyName, key);
      if (saved === null) sessionStorage.setItem(payloadName, JSON.stringify({ decision, comment }));
      const payload = saved ? JSON.parse(saved) as { decision: 'approve' | 'reject'; comment: string } : { decision, comment }; await service.decide(task.task_id, payload.decision, payload.comment, key); sessionStorage.removeItem(keyName); sessionStorage.removeItem(payloadName); setRetryDecision(null); setComment(''); await refresh();
    }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  async function prepare(taskId: string, personalized = '') {
    if (!service || !online || !modelReady || !canExecute || !projectId || busy || !active.current || execution[taskId] === 'legacy_pending' || execution[taskId] === 'uploading') return;
    setBusy(true); setError('');
    try {
      const result = await service.prepare(taskId, projectId);
      if (!active.current) return;
      const node = selected?.nodes.find(item => selected.tasks?.some(task => task.task_id === taskId && task.node_id === item.node_id));
      onTaskPrepared?.(taskId, { ...result, customInput: result.firstNode ? result.input : personalized,
        context: selected && node ? { instanceId: selected.id, workflowName: instanceName(selected, templateNames), nodeTitle: node.title, nodeOrder: node.order } : undefined });
    }
    catch (err) { setError(errorText(err)); await refresh(); } finally { setBusy(false); }
  }

  if (!service || !signedIn) return <main className="workflow-page"><h1>工作流</h1><p>{!service ? '本地 Runtime 未连接' : '登录企业账户后查看工作流'}</p></main>;
  const currentTask = selected?.status === 'running' ? selected.tasks?.find(task => task.status === 'pending' && Boolean(userId && workflowTaskCandidates(task).includes(userId))) : undefined;
  async function downloadArtifact(fileId: string) {
    if (!service || !selected || !projectId) return;
    setBusy(true);
    try { await service.downloadArtifact(selected.id, fileId, projectId); setError(''); }
    catch (error) { setSelected(null); setError(errorText(error)); }
    finally { setBusy(false); }
  }
  async function recoverExecution(taskId: string) {
    if (!service || !online || busy || !active.current) return;
    setBusy(true); setError('');
    try {
      const result = await service.recoverExecution(taskId);
      if (!active.current) return;
      setExecution(previous => ({ ...previous, [taskId]: result.status }));
      await refresh();
    } catch (error) { if (active.current) setError(errorText(error)); }
    finally { setBusy(false); }
  }
  const retryStart = template && userId && sessionStorage.getItem(`workflow:start:${ownerKey}:${template.id}`) !== null;
  const visibleTasks = tasks.filter(item => taskFilter === 'all' || item.type === taskFilter);
  const tasksPaginated = history.tasks.length > 0 || Boolean(nextCursors.tasks);
  const approvalTask = online && (tab === 'tasks' || tab === 'instances') && currentTask?.type === 'approval' ? currentTask : null;
  const executionBlockedReason = !online ? '本地 Runtime 未连接，请连接后执行'
    : !modelReady ? '模型尚未就绪，请先完成模型设置'
    : !canExecute ? '本地 Agent 不可用，请检查运行服务'
    : !projectId ? '请选择执行项目' : '';
  const agentAction = currentTask?.type === 'agent' ? <section className="workflow-execution" aria-label="当前节点执行">
    <div className="workflow-instance-heading"><strong>当前节点：{selected?.nodes.find(node => node.node_id === currentTask.node_id)?.title}</strong>{execution[currentTask.task_id] && <span role="status">{executionLabels[execution[currentTask.task_id] ?? ''] ?? '执行状态待更新'}</span>}</div>
    <div className="workflow-execution-settings">
      <label>执行项目{onSelectProject ? <select aria-label="执行项目" disabled={busy} value={projectId ?? ''} onChange={event => onSelectProject(event.target.value)}><option value="" disabled>请选择项目</option>{projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select> : <span>{projects.find(project => project.id === projectId)?.name ?? projectId ?? '未选择项目'}</span>}</label>
      <div className="workflow-execution-actions"><button disabled={busy || Boolean(executionBlockedReason) || ['uploading', 'legacy_pending'].includes(execution[currentTask.task_id] ?? '')} onClick={() => void prepare(currentTask.task_id, customInput)} type="button"><Play size={15} />{execution[currentTask.task_id] && execution[currentTask.task_id] !== 'idle' ? '继续处理节点' : '打开执行会话'}</button>{!modelReady && onOpenModelSettings && <button type="button" onClick={onOpenModelSettings}>前往模型设置</button>}</div>
    </div>
    {executionBlockedReason && <p className="workflow-muted" role="status">{executionBlockedReason}</p>}
    {selected?.nodes[0]?.node_id !== currentTask.node_id && <label>补充任务要求<textarea onChange={event => setCustomInput(event.target.value)} rows={3} value={customInput} /></label>}
  </section> : null;
  return <main className={`workflow-page${tab !== 'schedules' ? ' workflow-page--split' : ''}${approvalTask ? ' workflow-page--approval' : ''}`}>
    <header className="workflow-header"><h1>工作流</h1>{onOpenModelSettings && <button type="button" style={{ width: 'auto', padding: '0 12px' }} onClick={onOpenModelSettings}>返回模型设置</button>}<button aria-label="刷新工作流" disabled={!online} onClick={() => void refresh()} title="刷新工作流" type="button"><RefreshCw size={16} /></button></header>
    {!online && <p className="workflow-muted" role="status">当前离线，仅可查看已加载的工作流</p>}
    <nav aria-label="工作流视图" className="workflow-tabs">{([['tasks', '待我处理'], ['instances', '流程任务'], ['templates', '流程模板']] as const).map(([view, label]) => <button aria-current={tab === view ? 'page' : undefined} key={view} onClick={() => setTab(view)} type="button">{label}</button>)}{scheduleService && <button aria-current={tab === "schedules" ? "page" : undefined} type="button" onClick={() => { setTab("schedules"); setScheduleTemplate(null); }}>定时计划</button>}</nav>
    {error && <div className="workflow-error" role="alert"><span>{error}</span><button disabled={!online || busy} onClick={() => void refresh()} type="button">重试</button></div>}
    {tab === 'templates' && online && template?.status === 'enabled' && template.nodes.length > 0 && userId && scheduleService && <div className="workflow-actions"><button type="button" disabled={busy} onClick={() => { setScheduleTemplate(template); setTemplate(null); setTab('schedules'); }}>创建定时计划</button></div>}
    {tab === 'schedules' && scheduleService ? <WorkflowSchedules identityKey={ownerKey} service={scheduleService} online={online} createTemplate={scheduleTemplate} onOpenInstance={id => { setTab('instances'); setScheduleTemplate(null); void openInstance(id); }} /> : <div className="workflow-layout"><section aria-label="工作流列表" className="workflow-list">
      {tab === 'instances' && <select aria-label="流程任务状态" onChange={event => { clearSelection('instances'); setStatus(event.target.value); setCursors(previous => ({ ...previous, instances: '' })); setHistory(previous => ({ ...previous, instances: [] })); }} value={status}><option value="running">运行中</option><option value="all">全部</option><option value="succeeded">已完成</option><option value="rejected">已驳回</option><option value="terminated">已终止</option></select>}
      {tab === 'templates' && templates.map(item => <button className={template?.id === item.id ? 'selected' : ''} key={item.id} onClick={() => void openTemplate(item.id)} type="button"><strong>{item.name}</strong><small>版本 {item.revision} · {item.nodes.length} 个节点</small></button>)}
      {tab === 'instances' && instances.map(item => {
        const node = item.nodes.find(node => node.node_id === item.current_node_id);
        const task = item.tasks?.find(task => task.node_id === node?.node_id);
        const owners = (task ? workflowTaskCandidates(task) : node ? workflowNodeCandidates(node) : []).map(id => item.user_names?.[id] || id).join('、');
        return <button className={selected?.id === item.id ? 'selected' : ''} disabled={!online && selected?.id !== item.id} key={item.id} onClick={() => void openInstance(item.id)} type="button"><strong>{instanceName(item, templateNames)}</strong><small>{labels[item.status]} · {new Date(item.started_at).toLocaleString()}</small>{node && <small>当前节点：{node.title}{owners && ` · 负责人：${owners}`}</small>}</button>;
      })}
      {tab === 'tasks' && <>
        <div aria-label="待办类型" className="workflow-task-filters" role="group">
          {([['all', '全部'], ['approval', '待审批'], ['agent', '待执行']] as const).map(([value, label]) => <button aria-pressed={taskFilter === value} key={value} onClick={() => { if (value !== taskFilter) { clearSelection('tasks'); setTaskFilter(value); } }} type="button">{label}</button>)}
        </div>
        {tasksPaginated && <p className="workflow-muted workflow-task-scope">当前页 · {visibleTasks.length} 项</p>}
        {visibleTasks.map(item => {
          const context = instances.find(instance => instance.id === item.instance_id) ?? (selected?.id === item.instance_id ? selected : null);
          const reference = context ? `发起于 ${new Date(context.started_at).toLocaleString()}` : `流程任务 ${shortId(item.instance_id)}`;
          return <button aria-label={`${item.type === 'agent' ? 'Agent' : '审批'} · ${item.instruction || '未填写任务要求'} · ${reference}`} aria-pressed={selected?.id === item.instance_id} className={`workflow-task-row${selected?.id === item.instance_id ? ' selected' : ''}`} disabled={!online && selected?.id !== item.instance_id} key={item.task_id} onClick={() => void openInstance(item.instance_id)} title={`${item.instruction}\n流程任务 ${item.instance_id}`} type="button">
          <strong>{item.instruction || (item.type === 'agent' ? 'Agent 任务' : '审批任务')}</strong>
          <small>{reference}</small>
          <small className="workflow-task-meta">{item.type === 'agent' ? <Play size={13} aria-hidden="true" /> : <ClipboardCheck size={13} aria-hidden="true" />}{item.type === 'agent' ? nodeExecutionLabel(execution[item.task_id]) : '待审批'}{item.node_order !== undefined && <span>第 {item.node_order + 1} 步</span>}</small>
        </button>; })}
        {visibleTasks.length === 0 && <p className="workflow-muted" role="status">{tasksPaginated ? '当前页暂无匹配待办' : taskFilter === 'approval' ? '暂无待审批任务' : taskFilter === 'agent' ? '暂无待执行任务' : '暂无待办'}</p>}
      </>}
      {online && tab !== 'schedules' && history[tab].length > 0 && <button onClick={() => previousPage(tab)} type="button">上一页</button>}
      {online && tab !== 'schedules' && nextCursors[tab] && <button onClick={() => changePage(tab, nextCursors[tab])} type="button">下一页 <ArrowRight size={14} /></button>}
    </section><section aria-label="工作流详情" className="workflow-detail">
      {tab === 'templates' && template && <><h2>{template.name}</h2><p className="workflow-muted">{template.description}</p><WorkflowSteps nodes={template.nodes} userNames={template.user_names} action={online && Boolean(userId) && template.nodes.length > 0 ? <div className="workflow-actions"><label>任务要求<textarea disabled={Boolean(retryStart)} onChange={event => setInput(event.target.value)} rows={5} value={input} /></label>{retryStart && <p className="workflow-muted">上次发起尚未确认，仅可用原输入重试。</p>}<button disabled={busy} onClick={() => void start()} type="button">{retryStart ? '重试发起' : '发起任务'}</button></div> : null} /></>}
      {tab !== 'templates' && selected && <><div className="workflow-instance-heading"><h2 title={`流程任务 ID：${selected.id}`}>{instanceName(selected, templateNames)}</h2><span>{labels[selected.status]}</span></div>
        {selected.tasks?.some(task => task.artifacts?.length) && <section className="workflow-artifacts" aria-label="正式结果文件">
          <details key={selected.id}>
          <summary><File size={15} aria-hidden="true" /><span>正式结果文件</span><small>{selected.tasks.reduce((count, task) => count + (task.artifacts?.length ?? 0), 0)} 个文件</small><ChevronDown className="workflow-artifact-chevron" size={14} aria-hidden="true" /></summary>
          <ul className="workflow-artifact-list">{selected.tasks.flatMap(task => (task.artifacts ?? []).map(ref => <li key={ref.file_id}>
            <div className="workflow-artifact-name"><span title={ref.logical_path}><a href={workflowArtifactPreviewURL(ref.file_id)} rel="noreferrer" target="_blank">{ref.file_name ?? ref.logical_path} · 版本 {ref.revision}</a></span><small>{selected.nodes.find(node => node.node_id === task.node_id)?.title} · 文件 ID：{ref.file_id}</small></div>
            {projectId && online && <button aria-label="下载到项目" title="下载到项目" type="button" disabled={busy} onClick={() => void downloadArtifact(ref.file_id)}><Download size={15} /></button>}
          </li>))}</ul>
          <details className="workflow-artifact-paths"><summary>目录详情</summary>{selected.instance_path_prefix && <p>结果目录：<code>{selected.instance_path_prefix}</code></p>}{selected.tasks.flatMap(task => (task.artifacts ?? []).map(ref => <code key={ref.file_id}>{ref.logical_path}</code>))}</details>
          </details>
        </section>}
        {!selected.tasks?.some(task => task.artifacts?.length) && selected.instance_path_prefix && <details className="workflow-artifact-paths"><summary>结果目录</summary><code>{selected.instance_path_prefix}</code></details>}
        <WorkflowSteps key={`${selected.id}:${selected.current_node_id}:${selected.status}`} instanceStatus={selected.status} nodes={selected.nodes} tasks={selected.tasks ?? []} current={selected.current_node_id} execution={execution} userNames={selected.user_names} />
        {agentAction}</>}
      {tab !== 'templates' && online && currentTask?.type === 'agent' && execution[currentTask.task_id] === 'legacy_pending' && <div className="workflow-actions"><p className="workflow-muted">历史执行记录待确认</p><button type="button" disabled={busy} onClick={() => void recoverExecution(currentTask.task_id)}><RefreshCw size={15} />确认在当前企业恢复结果同步</button></div>}
      {(tab === 'templates' ? !template : !selected) && <div className="workflow-empty-state" role="status">
        <strong>{tab === 'templates' ? (templates.length > 0 ? '选择一个流程模板' : '暂无可用流程模板') : tab === 'instances' ? (instances.length > 0 ? '选择一个流程任务' : '暂无流程任务') : (visibleTasks.length > 0 ? '选择一个待办' : '暂无待办任务')}</strong>
        <p>{!online ? '本地 Runtime 未连接，恢复连接后可刷新列表。' : tab === 'templates' ? (templates.length > 0 ? '从左侧列表选择模板，查看节点和发起设置。' : '当前没有可用的流程模板。') : tab === 'instances' ? (instances.length > 0 ? '从左侧列表选择流程任务，查看节点进度和处理记录。' : '当前没有流程任务。') : (visibleTasks.length > 0 ? '从左侧列表选择待办，查看内容并继续处理。' : '当前没有符合条件的待办。')}</p>
      </div>}
    </section></div>}
    {approvalTask && <footer className="workflow-approval-dock" aria-busy={busy} aria-label="当前审批">
      <div className="workflow-actions">
        <span className="workflow-approval-target">当前审批：{selected?.nodes.find(node => node.node_id === approvalTask.node_id)?.title || approvalTask.instruction}</span>
        <label>审批意见<textarea disabled={retryDecision !== null} onChange={event => setComment(event.target.value)} rows={2} value={comment} /></label>
        <div className="workflow-approval-buttons"><button className="workflow-approval-approve" disabled={busy || retryDecision === 'reject'} onClick={() => void decide(approvalTask, 'approve')} type="button">{retryDecision === 'approve' ? '重试批准' : '批准'}</button><button className="workflow-approval-reject" disabled={busy || retryDecision === 'approve'} onClick={() => void decide(approvalTask, 'reject')} type="button">{retryDecision === 'reject' ? '重试驳回' : '驳回'}</button></div>
        {retryDecision && <p className="workflow-muted">上次提交尚未确认，仅可用原决定重试。</p>}
      </div>
    </footer>}
  </main>;
}

function WorkflowContent({ label, text }: { label: string; text: string }) {
  const [mode, setMode] = useState<'preview' | 'raw'>('preview');
  return <>
    <div className="workflow-content-heading">
      <span>{label}</span>
      <div className="workflow-content-modes" role="group" aria-label={`${label}显示方式`}>
        <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}><Eye size={14} aria-hidden="true" />预览</button>
        <button type="button" aria-pressed={mode === 'raw'} onClick={() => setMode('raw')}><FileText size={14} aria-hidden="true" />原文</button>
      </div>
    </div>
    {mode === 'preview' ? <MarkdownRenderer text={text} variant="document" className="workflow-content-preview" /> : <pre className="workflow-content-raw" tabIndex={0}>{text}</pre>}
  </>;
}

export function WorkflowSteps({ nodes, tasks, current, execution, action, userNames, instanceStatus }: { nodes: Node[]; tasks?: Task[]; current?: string; execution?: Record<string, string>; action?: ReactNode; userNames?: Record<string, string>; instanceStatus?: string }) {
  const [inspectedNode, setInspectedNode] = useState<string | null>(null);
  const compact = instanceStatus !== undefined;
  const defaultNode = nodes.find(node => node.node_id === current) ?? [...nodes].reverse().find(node => tasks?.some(task => task.node_id === node.node_id)) ?? nodes[0];
  const focusedNode = nodes.find(node => node.node_id === inspectedNode) ?? defaultNode;
  const steps = nodes.map((node, index) => {
    const task = tasks?.find(item => item.node_id === node.node_id);
    const isCurrent = current === node.node_id;
    const phase = !tasks ? 'template' : task && task.status !== 'pending' ? task.status === 'completed' || task.status === 'succeeded' ? 'completed' : 'stopped' : isCurrent ? compact && instanceStatus !== 'running' ? 'stopped' : 'current' : 'upcoming';
    const runStatus = task && execution?.[task.task_id];
    const status = phase === 'upcoming' ? '未执行' : phase === 'stopped' && isCurrent && instanceStatus && instanceStatus !== 'running' ? labels[instanceStatus] ?? '已停止' : phase === 'completed' || phase === 'stopped' ? labels[task?.status ?? ''] ?? '已处理' : node.type === 'approval' ? '待审批' : nodeExecutionLabel(runStatus);
    return { node, index, task, isCurrent, phase, status };
  });
  return <div className={compact ? 'workflow-run' : undefined}>
    {compact && <nav aria-label="节点进度" className="workflow-progress"><ol>{steps.map(({ node, index, phase, status, isCurrent }) => <li data-state={phase} key={node.node_id}>
      <button aria-label={`查看节点：${node.title} · ${status}`} aria-pressed={focusedNode?.node_id === node.node_id} aria-current={isCurrent && instanceStatus === 'running' ? 'step' : undefined} onClick={() => setInspectedNode(node.node_id)} type="button">
        <span className="workflow-index" aria-hidden="true">{index + 1}</span><span className="workflow-progress-label"><strong>{node.title}</strong><small>{status}</small></span>
      </button>
    </li>)}</ol></nav>}
    {compact && current && instanceStatus === 'running' && focusedNode?.node_id !== current && <button className="workflow-return-current" onClick={() => setInspectedNode(null)} type="button"><ArrowRight size={14} />返回当前节点</button>}
    <section aria-label={compact ? '节点详情' : undefined}>
      <ol className="workflow-steps">{steps.filter(({ node }) => !compact || node.node_id === focusedNode?.node_id).map(({ node, index, task, isCurrent, phase, status }) => {
        const candidates = task ? workflowTaskCandidates(task) : workflowNodeCandidates(node);
        const owners = (!tasks && node.assignee_initiator ? ['发起人', ...candidates] : candidates).map(id => userNames?.[id] || id).join('、');
        return <li data-state={phase} key={node.node_id}>
        {!compact && <span className="workflow-index">{index + 1}</span>}
        <div>
          <div className="workflow-step-heading">{compact ? <h3>{node.title}</h3> : <strong>{node.title}</strong>}{tasks && <span className="workflow-step-status">{status}</span>}</div>
          <small>{node.type === 'agent' ? 'Agent' : '审批'} · 负责人：{owners || '未配置账户'}{!tasks && node.assignee_role_ids?.length ? ` · 角色：${node.assignee_role_ids.join('、')}` : ''}</small>
          <p>{node.instruction}</p>
          {task?.handled_by && <p className="workflow-muted">实际处理人：{userNames?.[task.handled_by] || task.handled_by}</p>}
          {task && Boolean(node.type === 'approval' || textValue(task.input).trim() || task.output || task.decision) && <div className="workflow-data">{node.type === 'approval' ? <WorkflowContent key={`${task.task_id}:input`} label="待审批内容" text={textValue(task.input)} /> : textValue(task.input).trim() ? <><span>{index === 0 ? '任务要求' : '输入'}</span><pre tabIndex={compact ? 0 : undefined}>{textValue(task.input)}</pre></> : null}{task.output && <WorkflowContent key={`${task.task_id}:output`} label="输出" text={textValue(task.output)} />}{task.decision && <p>{task.decision === 'approve' ? '批准' : '驳回'} · {task.comment}</p>}</div>}
          {task?.artifacts?.length ? <section aria-label="正式结果文件" className="workflow-step-artifacts"><h4>正式结果文件</h4><ul>{task.artifacts.map(ref => <li key={ref.file_id}><a href={workflowArtifactPreviewURL(ref.file_id)} rel="noreferrer" target="_blank">{ref.file_name ?? ref.logical_path}</a><span>文件 ID：<code>{ref.file_id}</code> · 版本 {ref.revision}</span></li>)}</ul></section> : null}
          {(isCurrent || !tasks && index === 0) && action}
        </div>
      </li>;
      })}</ol>
    </section>
  </div>;
}
