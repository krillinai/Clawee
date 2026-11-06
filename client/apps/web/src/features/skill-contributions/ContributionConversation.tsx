import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Download, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import type { AgentEventEnvelope, RunResponse, SkillContributionDownload, SkillContributionQuery, ThreadHistoryResponse, ThreadResponse, ThreadRunsResponse } from '@clawee/protocol';
import { Timeline } from '../../components/timeline/Timeline.js';
import { eventToTimelineItem, type TimelineItem } from '../../components/timeline/timeline-model.js';
import type { RuntimeClient } from '../../runtime/client.js';
import type { SubscribeRunEventsInput } from '../../runtime/sse.js';
import type { ConnectionConfig } from '../../runtime/types.js';
import { contributionDownload, contributionQueryLabel, contributionToolBody } from './contribution-tools.js';
import { createRunEventController, type RunEventController } from '../runs/run-event-controller.js';
import { createRunReplayDeduper, mergeTimelineHistoryWithCache } from '../runs/run-event-replay.js';
import { applyRunEventToTimeline } from '../runs/run-event-application.js';
import { mapHistoryItemsToTimelineItems } from '../../components/timeline/history-mapping.js';
import { useRunRecoveryTriggers } from '../runs/use-run-recovery-triggers.js';
import { mergeHistoryWindows, type HistoryWindow } from '../conversation/use-thread-history.js';

const path = '/enterprise/skill-contribution-conversations';

function mergeItems(previous: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  return mergeTimelineHistoryWithCache(incoming, previous, 'older');
}

function historyItems(history: ThreadHistoryResponse): TimelineItem[] {
  return mapHistoryItemsToTimelineItems(history.items);
}

export function ContributionConversation(props: {
  client: RuntimeClient;
  connection: ConnectionConfig;
  subscribe(input: SubscribeRunEventsInput): Promise<void>;
  query: SkillContributionQuery;
  modelReady: boolean;
  onDownload(descriptor: SkillContributionDownload): Promise<void>;
  onDenied(error: unknown): void;
}) {
  const [threadId, setThreadId] = useState<string>();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string>();
  const [run, setRun] = useState<string>();
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [disconnected, setDisconnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [download, setDownload] = useState<SkillContributionDownload>();
  const [actualQuery, setActualQuery] = useState<SkillContributionQuery>();
  const [downloading, setDownloading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [connected, setConnected] = useState(true);
  const loadedThread = useRef<string>();
  const historyWindows = useRef<HistoryWindow[]>([]);
  const identity = useRef<RuntimeClient>();
  const controller = useRef<RunEventController>();
  const session = useRef<AbortController>();
  const olderRequest = useRef<AbortController>();
  const alive = useRef(true);
  const tools = useRef(new Map<string, string>());
  const seen = useRef(new Set<string>());
  const subscriber = useRef(props.subscribe);
  const denied = useRef(props.onDenied);
  subscriber.current = props.subscribe;
  denied.current = props.onDenied;

  useEffect(() => props.client.subscribeConnectionStatus(setConnected), [props.client]);

  function subscribe(input: SubscribeRunEventsInput) {
    return subscriber.current({ ...input, fetchImpl: () => props.client.rawGet(
      `/runs/${encodeURIComponent(input.runId)}/events?fromSeq=${input.fromSeq ?? 0}`,
      { signal: input.signal }
    ) });
  }

  function receive(event: AgentEventEnvelope, replay = false, apply = true) {
    const key = `${event.runId}:${event.id}`;
    if (seen.current.has(key)) return;
    seen.current.add(key);
    const callKey = 'toolCallId' in event.payload ? `${event.runId}:${event.payload.toolCallId}` : '';
    if (event.type === 'tool_use') tools.current.set(callKey, event.payload.name);
    const name = tools.current.get(callKey)?.split(/__|\./).at(-1);
    if (!replay && event.type === 'tool_result' && !event.payload.isError && (name === 'skill_contributions_query' || name === 'skill_contributions_export')) {
      const body = contributionToolBody(event.payload.response ?? event.payload.output);
      if (body?.query) setActualQuery(body.query as SkillContributionQuery);
      if (name === 'skill_contributions_export') setDownload(contributionDownload(body?.download));
    }
    if (apply) setItems(previous => applyRunEventToTimeline(previous, event));
  }

  function follow(runId: string, replayUntilSeq = 0, restoredItems: TimelineItem[] = []) {
    const signal = session.current?.signal;
    const deduper = createRunReplayDeduper(restoredItems, runId);
    controller.current?.stop();
    controller.current = createRunEventController({ subscribe });
    setRun(runId);
    controller.current.start({ ...props.connection, runId, fromSeq: 0,
        async onStreamEnd(lastSeq) {
          const snapshot = await props.client.get<RunResponse>(`/runs/${encodeURIComponent(runId)}`);
          if (!alive.current || signal?.aborted || snapshot.status === 'running' || snapshot.status === 'queued') return false;
          if (snapshot.lastEventSeq !== undefined && lastSeq < snapshot.lastEventSeq) return false;
          const id = snapshot.threadId ?? threadId;
          if (id === undefined) return false;
          const history = await props.client.get<ThreadHistoryResponse>(`${path}/${id}/history?limit=100`);
          if (!alive.current || signal?.aborted) return false;
          setItems(previous => mergeTimelineHistoryWithCache(historyItems(history), previous, 'latest'));
          setRuns(previous => [...previous.filter(value => value.id !== runId), snapshot]);
          setRun(undefined);
          return true;
        },
        onEvent(event) {
          if (!alive.current || signal?.aborted) return;
          const item = eventToTimelineItem(event);
          const apply = item !== null && (item.kind === 'assistant_message' || item.kind === 'approval' || deduper.shouldAppend(item));
          receive(event, event.seq <= replayUntilSeq, apply);
          if (event.type === 'done') {
            setRuns(previous => previous.map(value => value.id === runId ? { ...value, status: event.payload.status } : value));
            setRun(undefined);
          }
        },
        onStateChange(state) { if (alive.current && !signal?.aborted && state === 'disconnected') { setError('对话连接中断'); setDisconnected(true); } },
        onError(failure) { if (alive.current && !signal?.aborted) { setError('对话连接中断，请重试'); denied.current(failure); } }
    });
  }

  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    session.current = abort;
    controller.current?.stop();
    seen.current.clear(); tools.current.clear();
    const restoring = identity.current === props.client;
    identity.current = props.client;
    if (!restoring) {
      loadedThread.current = undefined; historyWindows.current = [];
      setThreadId(undefined); setItems([]); setRun(undefined); setRuns([]); setDownload(undefined); setActualQuery(undefined);
      setPrompt(''); setHasMore(false); setNextCursor(undefined);
    }
    setError(undefined); setLoading(true); setHistoryFailed(false); setLoadingOlder(false); setDownloading(false);
    setDisconnected(false);
    void (async () => {
      try {
        const response = await props.client.rawGet(`${path}/latest`, { signal: abort.signal });
        if (response.status === 204) {
          if (!abort.signal.aborted) { loadedThread.current = undefined; setThreadId(undefined); setItems([]); setRun(undefined); }
          return;
        }
        const { thread } = await response.json() as { thread: ThreadResponse };
        if (abort.signal.aborted) return;
        setThreadId(thread.id);
        const runs = await props.client.get<ThreadRunsResponse>(`${path}/${thread.id}/runs?limit=100`, { signal: abort.signal });
        const history = await props.client.get<ThreadHistoryResponse>(`${path}/${thread.id}/history?limit=100`, { signal: abort.signal });
        if (!alive.current || abort.signal.aborted) return;
        const sameThread = loadedThread.current === thread.id;
        const windows = mergeHistoryWindows(sameThread ? historyWindows.current : [], history, 'latest');
        historyWindows.current = windows;
        const restoredItems = historyItems({ ...history, items: windows.flatMap(window => window.items) });
        loadedThread.current = thread.id;
        setRuns(runs.runs);
        setItems(previous => sameThread ? mergeTimelineHistoryWithCache(restoredItems, previous, 'latest') : restoredItems);
        setHasMore(windows.at(-1)!.hasMore); setNextCursor(windows.at(-1)!.nextCursor);
        const latestRunId = runs.runs[0]?.id;
        let historyRunId: string | undefined;
        for (const item of history.items) {
          if (item.type === 'user_message') historyRunId = item.runId;
          if (item.type !== 'tool_result' || item.isError || !latestRunId || (item.runId ?? historyRunId) !== latestRunId) continue;
          const name = item.name.split(/__|\./).at(-1);
          if (name !== 'skill_contributions_query' && name !== 'skill_contributions_export') continue;
          const body = contributionToolBody(item.output);
          if (body?.query) setActualQuery(body.query as SkillContributionQuery);
          if (name === 'skill_contributions_export') setDownload(contributionDownload(body?.download));
        }
        const active = runs.runs.find(item => !['succeeded', 'failed', 'canceled'].includes(item.status));
        if (active) follow(active.id, active.lastEventSeq, restoredItems);
        else setRun(undefined);
      } catch (failure) {
        if (!abort.signal.aborted) {
          setError('对话历史加载失败，请重试'); setHistoryFailed(true); setDownload(undefined);
          if (restoring && loadedThread.current !== undefined) setDisconnected(true);
          denied.current(failure);
        }
      } finally { if (!abort.signal.aborted) setLoading(false); }
    })();
    return () => { alive.current = false; abort.abort(); olderRequest.current?.abort(); olderRequest.current = undefined; controller.current?.stop(); };
  }, [props.client, props.connection.baseUrl, props.connection.token, reload]);

  useRunRecoveryTriggers(() => {
    if (disconnected) { setDisconnected(false); setReload(value => value + 1); }
  }, connected);

  async function loadOlder() {
    if (!threadId || !hasMore || !nextCursor || loadingOlder || olderRequest.current) return;
    const abort = new AbortController();
    olderRequest.current = abort;
    setLoadingOlder(true); setError(undefined);
    try {
      const history = await props.client.get<ThreadHistoryResponse>(`${path}/${threadId}/history?limit=100&before=${encodeURIComponent(nextCursor)}`, { signal: abort.signal });
      if (abort.signal.aborted) return;
      const windows = mergeHistoryWindows(historyWindows.current, history, 'older');
      historyWindows.current = windows;
      setItems(previous => mergeItems(previous, historyItems({ ...history, items: windows.flatMap(window => window.items) })));
      setHasMore(windows.at(-1)!.hasMore); setNextCursor(windows.at(-1)!.nextCursor);
    } catch (failure) { if (!abort.signal.aborted) { setError('更早记录加载失败，请重试'); denied.current(failure); } }
    finally { if (olderRequest.current === abort) { olderRequest.current = undefined; if (!abort.signal.aborted) setLoadingOlder(false); } }
  }

  async function send() {
    if (!prompt.trim() || run || loading || historyFailed || !props.modelReady) return;
    const signal = session.current?.signal;
    const text = prompt.trim();
    const timestamp = new Date().toISOString();
    setLoading(true); setError(undefined); setDownload(undefined);
    try {
      let id = threadId;
      if (!id) { const response = await props.client.post<{ thread: ThreadResponse }>(path, {}); id = response.thread.id; if (!alive.current || signal?.aborted) return; setThreadId(id); }
      const started = await props.client.post<RunResponse>(`${path}/${id}/runs`, { prompt: text, query: props.query });
      if (!alive.current || signal?.aborted) return;
      setPrompt('');
      setItems(previous => [...previous, { kind: 'user_message', id: `prompt-${started.id}`, text, runId: started.id, timestamp, source: 'runtime' }]);
      follow(started.id);
    } catch (failure) { if (alive.current && !signal?.aborted) { setError('对话未能启动，请检查模型与企业连接'); denied.current(failure); } }
    finally { if (alive.current && !signal?.aborted) setLoading(false); }
  }

  return <section className="contribution-chat" aria-label="贡献对话">
    <header><h2>贡献对话</h2>{run ? <LoaderCircle size={16} className="contribution-spinner" aria-label="查询中" /> : null}</header>
    {loading ? <p role="status">正在加载对话</p> : null}
    <div className="contribution-chat-timeline"><Timeline conversationKey={threadId === undefined ? undefined : `contribution:${props.connection.baseUrl}:${threadId}`} items={items} runs={runs} hasMore={hasMore && !!nextCursor} loadingOlder={loadingOlder} onLoadOlder={loadOlder} /></div>
    {actualQuery ? <div className="contribution-query">{contributionQueryLabel(actualQuery)}</div> : null}
    {download ? <button className="contribution-download" disabled={downloading} onClick={() => {
      setDownloading(true); setError(undefined);
      void props.onDownload(download).catch(failure => { if (alive.current) { setError('CSV 下载失败，超过10,000行时请缩小查询范围'); denied.current(failure); } }).finally(() => { if (alive.current) setDownloading(false); });
    }}><Download size={15} />{downloading ? '正在下载' : '下载 CSV'}</button> : null}
    {error ? <p role="alert" className="inline-error">{error}</p> : null}
    {historyFailed ? <button type="button" className="inline-action" onClick={() => setReload(value => value + 1)}><RefreshCw size={15} />重试历史</button> : null}
    {disconnected ? <button type="button" className="inline-action" onClick={() => setReload(value => value + 1)}><RefreshCw size={15} />重试连接</button> : null}
    {!props.modelReady ? <p role="status">模型暂不可用</p> : null}
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label="贡献查询问题" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={!props.modelReady || loading || historyFailed || !!run} rows={3} />
      {run ? <button type="button" title="停止" aria-label="停止" onClick={() => void props.client.post(`/runs/${run}/cancel`).catch(failure => { setError('停止失败'); denied.current(failure); })}><Square size={16} /></button> : <button title="发送" aria-label="发送" disabled={!prompt.trim() || !props.modelReady || loading || historyFailed}><ArrowUp size={17} /></button>}
    </form>
  </section>;
}
