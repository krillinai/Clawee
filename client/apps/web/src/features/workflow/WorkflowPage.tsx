import { ArrowRight, Play, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Instance, Node, Task, Template, WorkflowService } from '../../services/workflow-service.js';
import './workflow.css';

const labels: Record<string, string> = { running: '运行中', succeeded: '已完成', rejected: '已驳回', terminated: '已终止', pending: '待处理', completed: '已完成', cancelled: '已取消' };
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败';
type View = 'templates' | 'instances' | 'tasks';

export function WorkflowPage({ service, signedIn, online, userId, cwd }: {
  service: WorkflowService | null;
  signedIn: boolean;
  online: boolean;
  userId?: string;
  cwd?: string;
}) {
  const [tab, setTab] = useState<View>('tasks');
  const [status, setStatus] = useState('running');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Instance | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [input, setInput] = useState('{}');
  const [comment, setComment] = useState('');
  const [retryDecision, setRetryDecision] = useState<'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [canExecute, setCanExecute] = useState(false);
  const [execution, setExecution] = useState<Record<string, string>>({});
  const [cursors, setCursors] = useState<Record<View, string>>({ templates: '', instances: '', tasks: '' });
  const [nextCursors, setNextCursors] = useState<Record<View, string>>({ templates: '', instances: '', tasks: '' });
  const [history, setHistory] = useState<Record<View, string[]>>({ templates: [], instances: [], tasks: [] });

  function changePage(view: View, next: string) {
    setHistory(previous => ({ ...previous, [view]: [...previous[view], cursors[view]] }));
    setCursors(previous => ({ ...previous, [view]: next }));
  }

  function previousPage(view: View) {
    const pages = history[view];
    setCursors(previous => ({ ...previous, [view]: pages.at(-1) ?? '' }));
    setHistory(previous => ({ ...previous, [view]: previous[view].slice(0, -1) }));
  }

  async function refresh() {
    if (!service || !online || !signedIn) return;
    try {
      const [templateList, instanceList, taskList, capability] = await Promise.all([
        service.templates(cursors.templates), service.instances(status, cursors.instances), service.tasks(cursors.tasks), service.capability()
      ]);
      setTemplates(templateList.data);
      setInstances(instanceList.data);
      setTasks(taskList.data);
      setNextCursors({ templates: templateList.meta.next_cursor, instances: instanceList.meta.next_cursor, tasks: taskList.meta.next_cursor });
      setCanExecute(capability.canExecute);
      if (selected) {
        const detail = await service.instance(selected.id);
        setSelected(detail.data);
      }
      setError('');
    } catch (err) { setError(errorText(err)); }
  }

  useEffect(() => {
    if (!online || !signedIn) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [service, signedIn, online, status, cursors.templates, cursors.instances, cursors.tasks, selected?.id]);

  useEffect(() => {
    if (!service || !online || !selected) return;
    const current = selected.tasks?.find(task => task.status === 'pending' && task.type === 'agent' && task.assignee_user_id === userId);
    if (!current) return;
    let active = true;
    const check = async () => {
      try { const result = await service.execution(current.task_id); if (active) setExecution(previous => ({ ...previous, [current.task_id]: result.status === 'failed' || result.status === 'conflict' ? result.status : result.runStatus ?? result.status })); }
      catch { /* Workflow status is refreshed separately. */ }
    };
    void check(); const timer = window.setInterval(() => void check(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [service, online, selected?.id, selected?.current_node_id, userId]);

  useEffect(() => {
    if (!template || !userId) return;
    const saved = sessionStorage.getItem(`workflow:start:${userId}:${template.id}:input`);
    if (saved !== null) setInput(saved);
  }, [template?.id, userId]);

  useEffect(() => {
    if (!selected || !userId) { setRetryDecision(null); return; }
    const task = selected.tasks?.find(item => item.status === 'pending' && item.type === 'approval' && item.assignee_user_id === userId);
    const saved = task && sessionStorage.getItem(`workflow:decision:${userId}:${task.task_id}:decision`);
    if (!saved) { setRetryDecision(null); return; }
    const value = JSON.parse(saved) as { decision: 'approve' | 'reject'; comment: string };
    setRetryDecision(value.decision); setComment(value.comment);
  }, [selected?.id, selected?.current_node_id, userId]);

  async function openTemplate(id: string) {
    if (!service) return;
    if (!online) {
      setTemplate(templates.find(item => item.id === id) ?? null);
      setSelected(null);
      return;
    }
    try { setTemplate((await service.template(id)).data); setSelected(null); setError(''); }
    catch (err) { setError(errorText(err)); }
  }
  async function openInstance(id: string) {
    if (!service || !online) return;
    try { setSelected((await service.instance(id)).data); setTemplate(null); setError(''); }
    catch (err) { setError(errorText(err)); }
  }
  async function start() {
    if (!service || !online || !template || busy) return;
    let initialInput: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(input); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); initialInput = parsed as Record<string, unknown>; }
    catch { setError('初始输入必须是 JSON 对象'); return; }
    setBusy(true); setError('');
    const keyName = `workflow:start:${userId}:${template.id}`;
    const key = sessionStorage.getItem(keyName) ?? crypto.randomUUID();
    const payloadName = `${keyName}:input`;
    const savedInput = sessionStorage.getItem(payloadName);
    sessionStorage.setItem(keyName, key);
    if (savedInput === null) sessionStorage.setItem(payloadName, JSON.stringify(initialInput));
    try { const result = await service.start(template.id, savedInput ? JSON.parse(savedInput) as Record<string, unknown> : initialInput, key); sessionStorage.removeItem(keyName); sessionStorage.removeItem(payloadName); await refresh(); await openInstance(result.data.instance_id); setTab('instances'); }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  async function decide(task: Task, decision: 'approve' | 'reject') {
    if (!service || !online || busy) return;
    setBusy(true); setError('');
    const keyName = `workflow:decision:${userId}:${task.task_id}`;
    const key = sessionStorage.getItem(keyName) ?? crypto.randomUUID();
    const payloadName = `${keyName}:decision`;
    const saved = sessionStorage.getItem(payloadName);
    sessionStorage.setItem(keyName, key);
    if (saved === null) sessionStorage.setItem(payloadName, JSON.stringify({ decision, comment }));
    try { const payload = saved ? JSON.parse(saved) as { decision: 'approve' | 'reject'; comment: string } : { decision, comment }; await service.decide(task.task_id, payload.decision, payload.comment, key); sessionStorage.removeItem(keyName); sessionStorage.removeItem(payloadName); setRetryDecision(null); setComment(''); await refresh(); }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  async function execute(task: Task) {
    if (!service || !online || !cwd || busy) return;
    setBusy(true); setError('');
    try { await service.execute(task.task_id, cwd); setExecution(previous => ({ ...previous, [task.task_id]: 'running' })); }
    catch (err) { setError(errorText(err)); await refresh(); } finally { setBusy(false); }
  }

  if (!service || !signedIn) return <main className="workflow-page"><h1>工作流</h1><p>{!service ? '本地 Runtime 未连接' : '登录企业账户后查看工作流'}</p></main>;
  const currentTask = selected?.tasks?.find(task => task.status === 'pending' && task.assignee_user_id === userId);
  const retryStart = template && userId && sessionStorage.getItem(`workflow:start:${userId}:${template.id}`) !== null;
  return <main className="workflow-page">
    <header className="workflow-header"><h1>工作流</h1><button aria-label="刷新工作流" disabled={!online} onClick={() => void refresh()} title="刷新工作流" type="button"><RefreshCw size={16} /></button></header>
    {!online && <p className="workflow-muted" role="status">当前离线，仅可查看已加载的工作流</p>}
    <nav aria-label="工作流视图" className="workflow-tabs">{([['tasks', '待办'], ['instances', '实例'], ['templates', '模板']] as const).map(([view, label]) => <button aria-current={tab === view ? 'page' : undefined} key={view} onClick={() => { setTab(view); setSelected(null); setTemplate(null); }} type="button">{label}{view === 'tasks' && tasks.length > 0 ? ` ${tasks.length}` : ''}</button>)}</nav>
    {error && <p className="workflow-error" role="alert">{error}</p>}
    <div className="workflow-layout"><section aria-label="工作流列表" className="workflow-list">
      {tab === 'instances' && <select aria-label="实例状态" onChange={event => { setStatus(event.target.value); setCursors(previous => ({ ...previous, instances: '' })); setHistory(previous => ({ ...previous, instances: [] })); }} value={status}><option value="running">运行中</option><option value="all">全部</option><option value="succeeded">已完成</option><option value="rejected">已驳回</option><option value="terminated">已终止</option></select>}
      {tab === 'templates' && templates.map(item => <button className={template?.id === item.id ? 'selected' : ''} key={item.id} onClick={() => void openTemplate(item.id)} type="button"><strong>{item.name}</strong><small>版本 {item.revision} · {item.nodes.length} 个节点</small></button>)}
      {tab === 'instances' && instances.map(item => <button className={selected?.id === item.id ? 'selected' : ''} disabled={!online && selected?.id !== item.id} key={item.id} onClick={() => void openInstance(item.id)} type="button"><strong>{item.nodes[0]?.title || item.id}</strong><small>{labels[item.status]} · {new Date(item.started_at).toLocaleString()}</small></button>)}
      {tab === 'tasks' && tasks.map(item => <button className={selected?.id === item.instance_id ? 'selected' : ''} disabled={!online && selected?.id !== item.instance_id} key={item.task_id} onClick={() => void openInstance(item.instance_id)} type="button"><strong>{item.type === 'agent' ? 'Agent' : '审批'} · {item.instruction}</strong><small>{item.instance_id}</small></button>)}
      {online && history[tab].length > 0 && <button onClick={() => previousPage(tab)} type="button">上一页</button>}
      {online && nextCursors[tab] && <button onClick={() => changePage(tab, nextCursors[tab])} type="button">下一页 <ArrowRight size={14} /></button>}
      {tab === 'tasks' && tasks.length === 0 && <p className="workflow-muted">暂无待办</p>}
    </section><section aria-label="工作流详情" className="workflow-detail">
      {template && <><h2>{template.name}</h2><p className="workflow-muted">{template.description}</p><WorkflowSteps nodes={template.nodes} />{online && template.nodes[0]?.assignee_user_id === userId && <div className="workflow-actions"><label>初始输入（JSON 对象）<textarea disabled={Boolean(retryStart)} onChange={event => setInput(event.target.value)} rows={5} value={input} /></label>{retryStart && <p className="workflow-muted">上次发起尚未确认，仅可用原输入重试。</p>}<button disabled={busy} onClick={() => void start()} type="button">{retryStart ? '重试发起' : '发起实例'}</button></div>}</>}
      {selected && <><h2>实例 {selected.id}</h2><p className="workflow-muted">{labels[selected.status]}</p><WorkflowSteps nodes={selected.nodes} tasks={selected.tasks} current={selected.current_node_id} />{online && currentTask?.type === 'approval' && <div className="workflow-actions"><label>审批意见<textarea disabled={retryDecision !== null} onChange={event => setComment(event.target.value)} rows={3} value={comment} /></label>{retryDecision && <p className="workflow-muted">上次提交尚未确认，仅可用原决定重试。</p>}<div><button disabled={busy || retryDecision === 'reject'} onClick={() => void decide(currentTask, 'approve')} type="button">{retryDecision === 'approve' ? '重试批准' : '批准'}</button><button disabled={busy || retryDecision === 'approve'} onClick={() => void decide(currentTask, 'reject')} type="button">{retryDecision === 'reject' ? '重试驳回' : '驳回'}</button></div></div>}{online && currentTask?.type === 'agent' && canExecute && cwd && <div className="workflow-actions"><button disabled={busy || execution[currentTask.task_id] === 'running' || execution[currentTask.task_id] === 'queued'} onClick={() => void execute(currentTask)} type="button"><Play size={15} />执行 Agent 任务</button>{execution[currentTask.task_id] && <span>{execution[currentTask.task_id]}</span>}</div>}</>}
      {!template && !selected && <p className="workflow-muted">选择一项查看详情</p>}
    </section></div>
  </main>;
}

function WorkflowSteps({ nodes, tasks, current }: { nodes: Node[]; tasks?: Task[]; current?: string }) {
  return <ol className="workflow-steps">{nodes.map((node, index) => {
    const task = tasks?.find(item => item.node_id === node.node_id);
    return <li key={node.node_id}><span className="workflow-index">{index + 1}</span><div><strong>{node.title}</strong><small>{node.type === 'agent' ? 'Agent' : '审批'} · {node.assignee_user_id}{current === node.node_id ? ' · 当前' : ''}</small><p>{node.instruction}</p>{task && <div className="workflow-data"><span>输入</span><pre>{JSON.stringify(task.input, null, 2)}</pre>{task.output && <><span>输出</span><pre>{JSON.stringify(task.output, null, 2)}</pre></>}{task.decision && <p>{task.decision === 'approve' ? '批准' : '驳回'} · {task.comment}</p>}</div>}</div></li>;
  })}</ol>;
}
