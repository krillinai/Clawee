import type { CodexModelResponse, RunResponse, ThreadResponse } from '@clawee/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { mapHistoryItemsToTimelineItems } from '../../components/timeline/history-mapping.js';
import { eventToTimelineItem, type TimelineItem } from '../../components/timeline/timeline-model.js';
import { ApiClientError, type RuntimeClient } from '../../runtime/client.js';
import type { SubscribeRunEventsInput } from '../../runtime/sse.js';
import type { ConnectionConfig } from '../../runtime/types.js';
import { createApprovalService } from '../../services/approval-service.js';
import { createRunService } from '../../services/run-service.js';
import { createThreadService } from '../../services/thread-service.js';
import { useThreadHistory } from '../conversation/use-thread-history.js';
import type { ClaweeProject } from '../projects/project-model.js';
import type { ComposerRunConfig } from '../runs/Composer.js';
import { createRunEventController } from '../runs/run-event-controller.js';
import { createRunReplayDeduper, mergeTimelineHistoryWithCache } from '../runs/run-event-replay.js';
import type { WorkbenchModuleContext } from './workbench-module-context.js';

export type WorkbenchConversationRuntime = {
  client: RuntimeClient | null;
  connection: ConnectionConfig | null;
  connected: boolean;
  project?: ClaweeProject;
  subjectId?: string;
  config: ComposerRunConfig;
  models?: readonly CodexModelResponse[];
  modelsLoading?: boolean;
  modelsError?: string;
  onUseDefaultProject?(): Promise<void>;
  onOpenExternal?(url: string): void;
  fetchImpl?: typeof fetch;
  subscribeRunEvents?(input: SubscribeRunEventsInput): Promise<void>;
};

function isActive(run: RunResponse | undefined) {
  return run?.status === 'queued' || run?.status === 'running';
}

export function useWorkbenchConversation(input: {
  runtime?: WorkbenchConversationRuntime;
  context: WorkbenchModuleContext;
  threadId?: string;
  onThreadCreated(thread: ThreadResponse): void;
}) {
  const client = input.runtime?.client;
  const services = useMemo(() => client === null || client === undefined ? undefined : {
    threads: createThreadService(client), runs: createRunService(client), approvals: createApprovalService(client)
  }, [client]);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [run, setRun] = useState<RunResponse>();
  const [sending, setSending] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restorationFailed, setRestorationFailed] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string>();
  const [streamError, setStreamError] = useState<string>();
  const [directoryRejected, setDirectoryRejected] = useState(false);
  const [repairingProject, setRepairingProject] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [runContextSummary, setRunContextSummary] = useState<string>();
  const [resolvingApprovalIds, setResolvingApprovalIds] = useState<Set<string>>(new Set());
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string | undefined>>({});
  const itemsRef = useRef(items);
  const runRef = useRef(run);
  const mountedRef = useRef(true);
  const sendingRef = useRef(false);
  const createdThreadRef = useRef<string>();
  const lastSeqRef = useRef(0);
  const runtimeRef = useRef(input.runtime);
  itemsRef.current = items;
  runRef.current = run;
  runtimeRef.current = input.runtime;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const history = useThreadHistory({ threadId: input.threadId, enabled: services !== undefined,
    service: services?.threads ?? null, reloadKey });
  useEffect(() => {
    if (!history.loaded) return;
    const activeRunId = isActive(runRef.current) ? runRef.current?.id : undefined;
    const mapped = mapHistoryItemsToTimelineItems(history.items).filter(item => item.id !== `${activeRunId}_done`);
    setItems(previous => mergeTimelineHistoryWithCache(mapped, previous));
  }, [history.loaded, history.items]);

  useEffect(() => {
    if (services === undefined || input.threadId === undefined || createdThreadRef.current === input.threadId) return;
    let canceled = false;
    setRestoring(true);
    setRestorationFailed(false);
    void Promise.all([
      services.threads.listThreadRuns(input.threadId),
      services.approvals.list({ threadId: input.threadId, status: 'pending' })
    ]).then(([response, approvals]) => {
      if (canceled) return;
      const active = response.runs.find(isActive);
      setRun(active);
      setItems(previous => [
        ...previous.filter(item => item.id !== `${active?.id}_done`),
        ...approvals.approvals.filter(approval => !previous.some(item => item.kind === 'approval' && item.approval.id === approval.id))
          .map(approval => ({ kind: 'approval' as const, id: approval.id, runId: approval.runId, approval, source: 'runtime' as const }))
      ]);
    }).catch(() => {
      if (!canceled) { setRestorationFailed(true); setError('无法恢复模块会话，请重试。'); }
    }).finally(() => {
      if (!canceled) setRestoring(false);
    });
    return () => { canceled = true; };
  }, [services, input.threadId, reloadKey]);

  const runId = isActive(run) ? run?.id : undefined;
  const baseUrl = input.runtime?.connection?.baseUrl;
  const token = input.runtime?.connection?.token;
  useEffect(() => {
    if (runId === undefined || baseUrl === undefined) return;
    const runtime = runtimeRef.current;
    const controller = createRunEventController({ subscribe: runtime?.subscribeRunEvents });
    const deduper = createRunReplayDeduper(itemsRef.current);
    let active = true;
    controller.start({
      runId, baseUrl, token, fromSeq: lastSeqRef.current, fetchImpl: runtime?.fetchImpl,
      onStateChange(state) {
        if (active && state === 'connected') setStreamError(undefined);
      },
      onEvent(event) {
        if (!active) return;
        lastSeqRef.current = event.seq;
        const item = eventToTimelineItem(event);
        if (item !== null && deduper.shouldAppend(item)) {
          setItems(previous => item.kind === 'approval'
            ? [...previous.filter(existing => existing.kind !== 'approval' || existing.approval.id !== item.approval.id), item]
            : [...previous, item]);
        }
        if (event.type === 'done') {
          setRun(current => current?.id === event.runId ? { ...current, status: event.payload.status } : current);
          setCanceling(false);
        }
      },
      onError() {
        if (active) setStreamError('对话连接中断，请重试连接。运行记录仍保存在本机。');
      }
    });
    return () => { active = false; controller.stop(); };
  }, [runId, baseUrl, token, reloadKey]);

  const projectUnavailable = directoryRejected || (input.runtime?.project?.directoryState !== undefined
    && input.runtime.project.directoryState !== 'available');
  const disabledReason = input.context.unavailableReason
    ?? (input.runtime?.connected !== true || services === undefined || input.runtime.connection === null ? '本地运行内核未连接' : undefined)
    ?? (input.runtime?.project === undefined ? '请先添加项目，再进行模块对话。' : undefined)
    ?? (repairingProject ? '正在准备默认项目' : undefined)
    ?? (projectUnavailable ? '当前项目目录不存在或不可访问，请使用默认项目后再发送。' : undefined)
    ?? (restoring || history.initialLoading ? '正在恢复模块会话' : undefined)
    ?? (restorationFailed ? '无法确认会话运行状态，请重试。' : undefined)
    ?? (history.error === undefined ? undefined : '模块历史加载失败，请重试。')
    ?? (sending ? '正在发送消息' : undefined)
    ?? (isActive(run) ? canceling ? '正在停止任务' : '正在分析数据，可停止当前任务' : undefined);

  async function send(prompt: string, config: ComposerRunConfig): Promise<boolean> {
    const runtime = input.runtime;
    const context = input.context.workbenchContext;
    if (sendingRef.current || disabledReason !== undefined || services === undefined || runtime?.project === undefined
      || runtime.connection === null || context === undefined || prompt.trim().length === 0) return false;
    sendingRef.current = true;
    setSending(true);
    setError(undefined);
    setStreamError(undefined);
    try {
      let threadId = input.threadId;
      if (threadId === undefined) {
        const response = await services.threads.createThread({ projectId: runtime.project.id,
          title: `${input.context.title} · ${input.context.summary}`, profile: config.profile,
          sandbox: 'read-only', ...(config.model === null ? {} : { model: config.model }),
          ...(config.reasoning === null ? {} : { reasoning: config.reasoning }) });
        if (!mountedRef.current) return false;
        threadId = response.thread.id;
        createdThreadRef.current = threadId;
        input.onThreadCreated(response.thread);
      }
      const nextRun = await services.runs.startThreadRun({ threadId, prompt, workbenchContext: context,
        model: config.model, reasoning: config.reasoning });
      if (!mountedRef.current) return true;
      lastSeqRef.current = 0;
      setRunContextSummary(input.context.summary);
      setItems(previous => [...previous, { kind: 'user_message', id: `${nextRun.id}_user`, runId: nextRun.id,
        text: prompt, runStatus: nextRun.status, source: 'runtime' }]);
      setRun(nextRun);
      return true;
    } catch (cause) {
      if (mountedRef.current) {
        if (cause instanceof ApiClientError && cause.code === 'PROJECT_DIRECTORY_UNAVAILABLE') {
          setDirectoryRejected(true);
          setError('当前项目目录不存在或不可访问。重新连接不能修复目录，请使用默认项目后再发送。');
        } else {
          setError(cause instanceof Error ? cause.message : '发送失败，请重试。');
        }
      }
      return false;
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setSending(false);
    }
  }

  async function useDefaultProject() {
    if (repairingProject || sending || isActive(run) || input.runtime?.onUseDefaultProject === undefined) return;
    setRepairingProject(true);
    try {
      await input.runtime.onUseDefaultProject();
      if (mountedRef.current) {
        setDirectoryRejected(false);
        setError(undefined);
      }
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : '无法准备默认项目，请检查目录权限。');
    } finally {
      if (mountedRef.current) setRepairingProject(false);
    }
  }

  async function cancel() {
    if (services === undefined || run === undefined || canceling) return;
    setCanceling(true);
    try {
      await services.runs.cancelRun(run.id);
    } catch (cause) {
      if (mountedRef.current) {
        setCanceling(false);
        setError(cause instanceof Error ? cause.message : '停止失败，请重试。');
      }
    }
  }

  async function resolveApproval(id: string, decision: 'approve' | 'reject') {
    if (services === undefined || resolvingApprovalIds.has(id)) return;
    setResolvingApprovalIds(previous => new Set(previous).add(id));
    setApprovalErrors(previous => ({ ...previous, [id]: undefined }));
    try {
      const response = decision === 'approve' ? await services.approvals.approve(id) : await services.approvals.reject(id);
      if (mountedRef.current) setItems(previous => previous.map(item => item.kind === 'approval' && item.approval.id === id
        ? { ...item, approval: response.approval } : item));
    } catch (cause) {
      if (mountedRef.current) setApprovalErrors(previous => ({ ...previous, [id]: cause instanceof Error ? cause.message : '审批失败' }));
    } finally {
      if (mountedRef.current) setResolvingApprovalIds(previous => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }

  return {
    items, running: isActive(run), canceling, disabledReason, error: error ?? streamError ?? history.error,
    runContextSummary, history, resolvingApprovalIds, approvalErrors, send, cancel, resolveApproval,
    projectUnavailable, repairingProject, projectRecoveryDisabled: repairingProject || sending || isActive(run), useDefaultProject,
    retry() { setError(undefined); setStreamError(undefined); setReloadKey(value => value + 1); }
  };
}
