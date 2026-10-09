import type { CreateWorkflowScheduleRequest, ScheduleOperationResponse, ScheduleResponse } from '@clawee/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../../runtime/errors.js';
import type { createScheduleService } from '../../services/schedule-service.js';
import type { Template } from '../../services/workflow-service.js';

type ScheduleService = ReturnType<typeof createScheduleService>;
type Editor = { id?: string; templateId: string; name: string; cron: string; timezone: string; enabled: boolean; input: string };
type PendingCreation = CreateWorkflowScheduleRequest & { requestId: string; name: string; timezone: string; enabled: boolean };
const operationLabels: Record<string, string> = { succeeded: '发起成功', failed: '发起失败或结果未知', skipped: '已跳过', queued: '等待发起' };

function readPendingCreation(key?: string): PendingCreation | null {
  if (!key) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as PendingCreation | null;
    if (!value || value.action !== 'workflow_start' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)
      || typeof value.name !== 'string' || typeof value.cron !== 'string' || typeof value.timezone !== 'string' || typeof value.enabled !== 'boolean'
      || typeof value.workflow?.templateId !== 'string' || !value.workflow.initialInput || typeof value.workflow.initialInput !== 'object' || Array.isArray(value.workflow.initialInput)) return null;
    return { action: 'workflow_start', requestId: value.requestId, name: value.name, cron: value.cron, timezone: value.timezone, enabled: value.enabled,
      workflow: { templateId: value.workflow.templateId, initialInput: value.workflow.initialInput } };
  } catch { return null; }
}

function clearPendingCreation(key: string | undefined, requestId: string) {
  try {
    if (key && readPendingCreation(key)?.requestId === requestId) sessionStorage.removeItem(key);
  } catch { }
}

function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError)) return fallback;
  if (error.code === 'ENTERPRISE_UNAUTHORIZED' || error.status === 401) return '企业会话已失效，请重新登录';
  if (error.code === 'ENTERPRISE_FORBIDDEN' || error.status === 403) return '没有权限，或计划不属于当前账号、Agent 或服务';
  if (error.code === 'SCHEDULE_NOT_FOUND' || error.status === 404) return '计划或模板不存在，请刷新';
  if (error.code === 'CRON_INVALID' || error.code === 'SCHEDULE_INVALID') return 'Cron 或时区无效，请检查计划设置';
  if (error.status === 400) return '计划内容无效，请检查名称、Cron、时区与初始输入';
  return fallback;
}

export function WorkflowSchedules(props: Parameters<typeof WorkflowSchedulesContent>[0]) {
  return <WorkflowSchedulesContent key={props.identityKey} {...props} />;
}

function WorkflowSchedulesContent({ service, online, identityKey, createTemplate, onOpenInstance }: {
  service: ScheduleService;
  online: boolean;
  identityKey?: string;
  createTemplate: Template | null;
  onOpenInstance(id: string): void;
}) {
  const [schedules, setSchedules] = useState<ScheduleResponse[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [operations, setOperations] = useState<ScheduleOperationResponse[]>([]);
  const pendingKey = identityKey ? `workflow:schedule-create:${identityKey}` : undefined;
  const [pendingCreation, setPendingCreation] = useState<PendingCreation | null>(() => readPendingCreation(pendingKey));
  const [editor, setEditor] = useState<Editor | null>(() => pendingCreation ? {
    templateId: pendingCreation.workflow.templateId, name: pendingCreation.name, cron: pendingCreation.cron, timezone: pendingCreation.timezone,
    enabled: pendingCreation.enabled, input: JSON.stringify(pendingCreation.workflow.initialInput, null, 2)
  } : createTemplate ? {
    templateId: createTemplate.id, name: `${createTemplate.name}定时计划`, cron: '0 9 * * *',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', enabled: true, input: '{}'
  } : null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const listGeneration = useRef(0);
  const operationsGeneration = useRef(0);
  const selected = schedules.find(item => item.id === selectedId);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; listGeneration.current += 1; operationsGeneration.current += 1; };
  }, []);

  const load = useCallback(async () => {
    if (!online) return;
    const generation = ++listGeneration.current;
    try {
      const result = await service.listSchedules(true);
      if (alive.current && generation === listGeneration.current) setSchedules(result.schedules.filter(item => item.action === 'workflow_start'));
    } catch (err) {
      if (alive.current && generation === listGeneration.current) setError(errorText(err, '无法加载本机工作流计划'));
    }
  }, [service, online]);

  const loadOperations = useCallback(async (id: string) => {
    const generation = ++operationsGeneration.current;
    try {
      const result = await service.listOperations(id);
      if (alive.current && generation === operationsGeneration.current) setOperations(result.operations);
    } catch (err) {
      if (alive.current && generation === operationsGeneration.current) setError(errorText(err, '无法加载触发记录，请刷新后再重试'));
    }
  }, [service]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => { listGeneration.current += 1; window.clearInterval(timer); };
  }, [load]);

  useEffect(() => {
    setConfirmDelete(false);
    if (!selectedId || !online) return;
    setOperations([]);
    void loadOperations(selectedId);
    const timer = window.setInterval(() => void loadOperations(selectedId), 15000);
    return () => { operationsGeneration.current += 1; window.clearInterval(timer); };
  }, [selectedId, online, loadOperations]);

  async function save() {
    if (!editor || !online || busy) return;
    const name = editor.name.trim();
    const cron = editor.cron.trim();
    const timezone = editor.timezone.trim();
    if (!name || !cron || !timezone) { setError('请输入计划名称、Cron 和时区'); return; }
    try { Intl.DateTimeFormat(undefined, { timeZone: timezone }); }
    catch { setError('请输入有效的 IANA 时区'); return; }
    let initialInput: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(editor.input);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      initialInput = parsed as Record<string, unknown>;
    } catch { setError('初始输入必须是有效的 JSON 对象'); return; }
    if (new TextEncoder().encode(JSON.stringify(initialInput)).byteLength > 1024 * 1024) {
      setError('初始输入不能超过 1 MiB'); return;
    }
    setBusy(true); setError(''); setNotice('');
    const input = { name, cron, timezone, enabled: editor.enabled, workflow: { templateId: editor.templateId, initialInput } };
    const creation = editor.id ? null : pendingCreation ?? { action: 'workflow_start' as const, requestId: crypto.randomUUID(), ...input };
    if (creation && !pendingCreation) {
      try { if (pendingKey) sessionStorage.setItem(pendingKey, JSON.stringify(creation)); }
      catch { setBusy(false); setError('无法保留创建请求，请启用当前会话存储后重试；计划尚未提交'); return; }
      setPendingCreation(creation);
    }
    try {
      const result = editor.id ? await service.updateSchedule(editor.id, input) : await service.createWorkflowSchedule(creation!);
      if (creation) clearPendingCreation(pendingKey, creation.requestId);
      if (!alive.current) return;
      setPendingCreation(null);
      setEditor(null); setSelectedId(result.id); setNotice('计划已保存'); await load();
    } catch (err) {
      const rejected = !pendingCreation && alive.current && err instanceof ApiClientError && err.status >= 400 && err.status < 500 && err.status !== 408;
      if (creation && rejected) clearPendingCreation(pendingKey, creation.requestId);
      if (alive.current) {
        if (rejected) setPendingCreation(null);
        setError(errorText(err, creation && !rejected ? '创建结果未知，请重试创建计划；将复用原请求与原内容，不会另建计划' : '无法保存工作流计划，请稍后重试'));
      }
    }
    finally { if (alive.current) setBusy(false); }
  }

  async function edit() {
    if (!selected || !online || busy) return;
    setBusy(true); setError('');
    try {
      const detail = await service.getSchedule(selected.id);
      if (!alive.current) return;
      if (detail.action !== 'workflow_start' || !detail.workflow) { setError('工作流计划配置不可用，请刷新'); return; }
      setEditor({ id: detail.id, templateId: detail.workflow.templateId, name: detail.name, cron: detail.cron, timezone: detail.timezone,
        enabled: detail.enabled, input: JSON.stringify(detail.workflow.initialInput, null, 2) });
    } catch (err) { if (alive.current) setError(errorText(err, '无法读取完整计划，请稍后重试')); }
    finally { if (alive.current) setBusy(false); }
  }

  async function change(remove = false) {
    if (!selected || !online || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (remove) await service.deleteSchedule(selected.id);
      else await service.updateSchedule(selected.id, { enabled: !selected.enabled });
      if (!alive.current) return;
      if (remove) { setSelectedId(undefined); setEditor(null); }
      setConfirmDelete(false); await load();
    } catch (err) { if (alive.current) setError(errorText(err, remove ? '无法删除计划' : '无法更新计划状态')); }
    finally { if (alive.current) setBusy(false); }
  }

  async function run(triggerId?: string) {
    if (!selected || !online || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = triggerId ? await service.runNow(selected.id, { triggerId }) : await service.runNow(selected.id);
      if (!alive.current) return;
      setNotice(result.workflowInstanceId ? `已发起实例 ${result.workflowInstanceId}` : result.queued ? '触发正在处理中，请查看触发记录' : result.skipped ? '本次触发已跳过，请查看触发记录' : '触发已提交，请查看触发记录确认结果');
      await load();
    } catch (err) {
      if (alive.current) setError(errorText(err, '发起失败或结果未知，请在触发记录中重试原触发，不要重复立即发起'));
    } finally {
      if (alive.current) { await loadOperations(selected.id); setBusy(false); }
    }
  }

  function updateEditor(value: Partial<Editor>) {
    if (pendingCreation || busy) return;
    setEditor(previous => previous ? { ...previous, ...value } : null);
  }

  return <section aria-label="本机工作流计划">
    <p className="workflow-muted">由当前客户端发起，客户端 daemon 需保持在线并连接企业服务；不通过 LLM，定时只创建实例与待办，不自动执行节点。离线或休眠时 Gateway 不接管。</p>
    {error && <p className="workflow-error" role="alert">{error}</p>}
    {notice && <p className="workflow-muted" role="status">{notice}</p>}
    {pendingCreation && <p className="workflow-muted" role="status">创建结果待确认，已保留原请求与原内容；请重试创建计划，不要另建同一计划。</p>}
    {editor && online && <form aria-label={editor.id ? '编辑工作流定时计划' : '创建工作流定时计划'} className="workflow-actions" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="workflow-muted">模板：{editor.templateId}</p>
      <label>计划名称<input disabled={busy || !!pendingCreation} value={editor.name} onChange={event => updateEditor({ name: event.target.value })} /></label>
      <label>Cron<input disabled={busy || !!pendingCreation} value={editor.cron} placeholder="0 9 * * *" onChange={event => updateEditor({ cron: event.target.value })} /></label>
      <label>时区<input disabled={busy || !!pendingCreation} value={editor.timezone} placeholder="Asia/Shanghai" onChange={event => updateEditor({ timezone: event.target.value })} /></label>
      <label>初始输入（JSON 对象）<textarea disabled={busy || !!pendingCreation} rows={5} value={editor.input} onChange={event => updateEditor({ input: event.target.value })} /></label>
      <label><input type="checkbox" disabled={busy || !!pendingCreation} checked={editor.enabled} onChange={event => updateEditor({ enabled: event.target.checked })} />启用计划</label>
      <div><button type="submit" disabled={busy}>{pendingCreation ? '重试创建计划' : '保存计划'}</button><button type="button" disabled={busy || !!pendingCreation} onClick={() => { setEditor(null); setError(''); }}>取消编辑</button></div>
    </form>}
    <div className="workflow-layout"><section aria-label="工作流计划列表" className="workflow-list">
      <button type="button" disabled={!online || busy} onClick={() => { setError(''); void load(); if (selectedId) void loadOperations(selectedId); }}>刷新计划与记录</button>
      {schedules.map(item => <button type="button" key={item.id} className={selectedId === item.id ? 'selected' : ''} disabled={busy || !!pendingCreation || !online && selectedId !== item.id} onClick={() => { setSelectedId(item.id); setEditor(null); setError(''); setNotice(''); }}>
        <strong>{item.name}</strong><small>{item.enabled ? '已启用' : '已暂停'} · {item.cron} · {item.timezone}</small>
      </button>)}
      {schedules.length === 0 && <p className="workflow-muted">暂无本机工作流计划；请先选择合法模板创建。</p>}
    </section><section aria-label="工作流计划详情" className="workflow-detail">
      {selected && <><h2>{selected.name}</h2><p className="workflow-muted">模板：{selected.workflow?.templateId} · 下次发起：{selected.nextRunAt ? new Date(selected.nextRunAt).toLocaleString() : '未安排'}</p>
        {online && <div className="workflow-actions"><div>
          <button type="button" disabled={busy} onClick={() => void edit()}>编辑计划</button>
          <button type="button" disabled={busy} onClick={() => void change()}>{selected.enabled ? '暂停计划' : '启用计划'}</button>
          <button type="button" disabled={busy} onClick={() => void run()}>立即发起</button>
          <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>删除计划</button>
        </div>{confirmDelete && <div><p>确认删除此计划？已有实例不会被删除。</p><button type="button" disabled={busy} onClick={() => void change(true)}>确认删除</button><button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>取消删除</button></div>}</div>}
        {online && selected.lastWorkflowInstanceId && <div className="workflow-actions"><button type="button" disabled={busy} onClick={() => onOpenInstance(selected.lastWorkflowInstanceId!)}>查看最近实例</button></div>}
        <h3>触发记录</h3><p className="workflow-muted">未知结果重试复用原触发与原输入；立即发起是新触发。</p>
        <ul className="workflow-steps">{operations.map(item => <li key={item.id}><div>
          <strong>{operationLabels[item.status] ?? '状态待确认'} · {new Date(item.createdAt).toLocaleString()}</strong>
          {item.triggerId && <p>触发：{item.triggerId}</p>}{item.errorMessage && <p className="workflow-error">{item.errorMessage}</p>}
          {online && item.workflowInstanceId && <div className="workflow-actions"><button type="button" disabled={busy} onClick={() => onOpenInstance(item.workflowInstanceId!)}>查看关联实例</button></div>}
          {online && item.status === 'failed' && item.triggerId && !operations.some(record => record.triggerId === item.triggerId && record.workflowInstanceId) && <div className="workflow-actions"><button type="button" disabled={busy} onClick={() => void run(item.triggerId!)}>重试原触发</button></div>}
        </div></li>)}</ul>
        {operations.length === 0 && <p className="workflow-muted">暂无触发记录</p>}
      </>}
    </section></div>
  </section>;
}
