import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope, RunResponse, ThreadHistoryItem, ThreadHistoryResponse } from '@clawee/protocol';
import { RuntimeClient } from '../../runtime/client.js';
import { subscribeRunEvents, type SubscribeRunEventsInput } from '../../runtime/sse.js';
import type { TimelineItem } from '../../components/timeline/timeline-model.js';
import { ContributionConversation } from './ContributionConversation.js';

vi.mock('../../components/timeline/Timeline.js', () => ({ Timeline: (props: {
  items: TimelineItem[];
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?(): void;
}) => <div>
  {props.hasMore ? <button disabled={props.loadingOlder} onClick={props.onLoadOlder}>{props.loadingOlder ? '正在加载更早记录' : '加载更早记录'}</button> : null}
  <ol aria-label="会话时间线">{props.items.map(item => <li key={item.id} data-item-id={item.id}>{'text' in item ? item.text : 'name' in item ? item.name : item.kind}</li>)}</ol>
</div> }));

const query = { start_date: '2026-10-01', end_date: '2026-10-13', report: 'first_approvals' as const };

function toolEvents(runId: string, result: unknown, name = 'skill_contributions__skill_contributions_export'): AgentEventEnvelope[] {
  return [
    { id: `${runId}-use`, runId, seq: 1, ts: '2026-10-13T08:00:01Z', normalizerVersion: 1, type: 'tool_use', payload: { type: 'tool_use', toolCallId: 'call-1', name, input: {} } },
    { id: `${runId}-result`, runId, seq: 2, ts: '2026-10-13T08:00:02Z', normalizerVersion: 1, type: 'tool_result', payload: { type: 'tool_result', toolCallId: 'call-1', isError: false, output: '', response: result } },
    { id: `${runId}-done`, runId, seq: 3, ts: '2026-10-13T08:00:03Z', normalizerVersion: 1, type: 'done', payload: { type: 'done', status: 'succeeded', terminationReason: 'completed' } }
  ];
}

const exportResult = { query, timezone: 'Asia/Shanghai', download: { type: 'skill_contributions_csv', query } };
const recentHistory: ThreadHistoryItem[] = [
  { id: 'question', type: 'user_message', text: '导出首次通过名单', createdAt: '2026-10-13T08:00:00Z', runId: 'run-1' },
  { id: 'answer', rawEventId: 'answer-item', type: 'assistant_message', runId: 'run-1', text: '已查询并准备导出', createdAt: '2026-10-13T08:00:04Z' }
];

function toolHistory(events: AgentEventEnvelope[]): ThreadHistoryItem[] {
  const names = new Map<string, string>();
  return events.flatMap((event): ThreadHistoryItem[] => {
    const base = { id: `run-event:${event.id}`, eventId: event.id, eventSeq: event.seq, runId: event.runId, createdAt: event.ts };
    if (event.type === 'tool_use') {
      names.set(`${event.runId}:${event.payload.toolCallId}`, event.payload.name);
      return [{ ...base, type: 'tool_use', name: event.payload.name, input: event.payload.input }];
    }
    if (event.type === 'tool_result') return [{ ...base, type: 'tool_result', runId: event.runId,
      name: names.get(`${event.runId}:${event.payload.toolCallId}`) ?? event.payload.toolCallId,
      output: event.payload.output || (event.payload.response === undefined ? '' : JSON.stringify(event.payload.response)), isError: event.payload.isError }];
    if (event.type === 'done') return [{ ...base, type: 'done', terminalSource: 'daemon', status: event.payload.status }];
    return [];
  });
}

function historyFixture(options: {
  events?: AgentEventEnvelope[];
  historyEvents?: AgentEventEnvelope[];
  history?: Partial<ThreadHistoryResponse>;
  older?: (before: string) => Response | Promise<Response>;
  historyStatus?: number;
  runStatus?: string;
  runs?: RunResponse[];
  runEvents?: Record<string, AgentEventEnvelope[]>;
  subscribe?: (input: SubscribeRunEventsInput) => Promise<void>;
} = {}) {
  const requests: Array<{ url: URL; authorization: string | null; signal?: AbortSignal | null }> = [];
  const client = new RuntimeClient({ baseUrl: 'http://localhost:9999', token: 'local-token', fetchImpl: async (url, init) => {
    const parsed = new URL(String(url));
    requests.push({ url: parsed, authorization: new Headers(init?.headers).get('Authorization'), signal: init?.signal });
    if (parsed.pathname.endsWith('/latest')) return Response.json({ thread: { id: 'thread-1' } });
    if (parsed.pathname.endsWith('/history')) {
      if (options.historyStatus) return Response.json({ error: { code: 'FORBIDDEN', message: '禁止' } }, { status: options.historyStatus });
      const before = parsed.searchParams.get('before');
      if (before && options.older) return options.older(before);
      const events = options.runEvents ? Object.values(options.runEvents).flat() : options.events ?? toolEvents('run-1', exportResult);
      const items = [...(options.history?.items ?? recentHistory), ...toolHistory(options.historyEvents ?? events)].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return Response.json({ threadId: 'thread-1', hasMore: false, ...options.history, items });
    }
    if (parsed.pathname.endsWith('/runs')) return Response.json({ runs: options.runs ?? [{ id: 'run-1', status: options.runStatus ?? 'succeeded', lastEventSeq: 3 }] });
    if (parsed.pathname.endsWith('/events')) {
      const runId = parsed.pathname.split('/')[2] ?? '';
      const events = options.runEvents?.[runId] ?? options.events ?? toolEvents('run-1', exportResult);
      return new Response(events.map(event => `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`未预期请求 ${parsed.pathname}`);
  } });
  const onDownload = vi.fn(async () => undefined);
  const onDenied = vi.fn();
  const subscribe = vi.fn(options.subscribe ?? subscribeRunEvents);
  const view = render(<ContributionConversation client={client} connection={{ baseUrl: 'http://localhost:9999', token: 'local-token' }} subscribe={subscribe} query={query} modelReady onDownload={onDownload} onDenied={onDenied} />);
  return { requests, onDownload, onDenied, subscribe, view, client };
}

describe('贡献对话复用 Runtime', () => {
  it('耗尽后恢复保留不重叠旧页、正文 DOM 和旧分页游标', async () => {
    const older = vi.fn(async () => Response.json({ threadId: 'thread-1', items: [
      { id: 'older', type: 'user_message', text: '上月上传', createdAt: '2026-09-30T08:00:00Z' }
    ], hasMore: true, nextCursor: 'oldest-cursor' }));
    let fail!: (error: Error) => void;
    const subscribe = vi.fn((input: SubscribeRunEventsInput) => new Promise<void>((resolve, reject) => {
      fail = reject;
      input.signal?.addEventListener('abort', () => resolve(), { once: true });
    }));
    const { requests } = historyFixture({ runStatus: 'running', events: [], history: { hasMore: true, nextCursor: 'older-cursor' }, older, subscribe });
    await screen.findByText('已查询并准备导出');
    fireEvent.click(screen.getByRole('button', { name: '加载更早记录' }));
    await screen.findByText('上月上传');
    expect([...screen.getByRole('list').children].map(item => item.textContent)).toEqual(['上月上传', '导出首次通过名单', '已查询并准备导出']);
    const body = screen.getByText('已查询并准备导出');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const delay of [0, 500, 1000, 2000, 4000, 8000]) {
        await act(async () => { if (delay > 0) await vi.advanceTimersByTimeAsync(delay); fail(new Error('断流')); await Promise.resolve(); });
      }
      expect(screen.getByRole('button', { name: '重试连接' })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(subscribe).toHaveBeenCalledTimes(6);
      fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
      await act(async () => { await Promise.resolve(); });
      expect(subscribe).toHaveBeenCalledTimes(7);
      expect(screen.getByText('已查询并准备导出')).toBe(body);
      expect(screen.getByText('上月上传')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '加载更早记录' }));
      await act(async () => { await Promise.resolve(); });
      expect(older).toHaveBeenLastCalledWith('oldest-cursor');
      expect(requests.filter(request => request.url.pathname.endsWith('/latest'))).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it('无项目创建企业会话，继承条件并将真实导出描述变成按钮', async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const client = new RuntimeClient({ baseUrl: 'http://localhost:9999', fetchImpl: async (url, options) => {
      const path = new URL(String(url)).pathname;
      requests.push({ path, body: options?.body ? JSON.parse(String(options.body)) : undefined });
      if (path.endsWith('/latest')) return new Response(null, { status: 204 });
      if (path.endsWith('/runs')) return Response.json({ id: 'run-1', status: 'running', lastEventSeq: 0 });
      return Response.json({ thread: { id: 'thread-1' } });
    } });
    const subscribe = vi.fn(async (input: SubscribeRunEventsInput) => {
      const payloads = [
        { type: 'tool_use', toolCallId: 'call-1', name: 'skill_contributions.skill_contributions_export', input: {} },
        { type: 'tool_result', toolCallId: 'call-1', isError: false, output: '', response: { structuredContent: { query, timezone: 'Asia/Shanghai', download: { type: 'skill_contributions_csv', query } } } },
        { type: 'done', status: 'succeeded', terminationReason: 'completed' }
      ];
      payloads.forEach((payload, index) => input.onEvent({ id: `event-${index}`, runId: 'run-1', seq: index + 1, type: payload.type, payload } as AgentEventEnvelope));
    });
    const download = vi.fn(async () => undefined);
    render(<ContributionConversation client={client} connection={{ baseUrl: 'http://localhost:9999' }} subscribe={subscribe} query={query} modelReady onDownload={download} onDenied={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText('贡献查询问题')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('贡献查询问题'), { target: { value: '导出首次通过名单' } });
    fireEvent.click(screen.getByLabelText('发送'));
    await screen.findByRole('button', { name: '下载 CSV' });
    expect(requests.find(item => item.path.endsWith('conversations'))?.body).toEqual({});
    expect(requests.find(item => item.path.endsWith('/runs'))?.body).toEqual({ prompt: '导出首次通过名单', query });
    expect(screen.getByText(/2026-10-01 · 至 2026-10-13 · 首次通过/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下载 CSV' }));
    await waitFor(() => expect(download).toHaveBeenCalledWith({ type: 'skill_contributions_csv', query }));
  });
  it('模型不可用不发起执行', async () => {
    const client = new RuntimeClient({ baseUrl: 'http://localhost:9999', fetchImpl: async () => new Response(null, { status: 204 }) });
    render(<ContributionConversation client={client} connection={{ baseUrl: 'http://localhost:9999' }} subscribe={async () => undefined} query={query} modelReady={false} onDownload={async () => undefined} onDenied={() => undefined} />);
    expect(screen.getByText('模型暂不可用')).toBeInTheDocument();
    expect(screen.getByLabelText('发送')).toBeDisabled();
    await waitFor(() => expect(screen.queryByText('正在加载对话')).not.toBeInTheDocument());
  });

  it('从认证历史直接恢复工具、实际条件与 CSV，不重放已完成 Run', async () => {
    const { requests, onDownload, subscribe } = historyFixture();
    await screen.findByRole('button', { name: '下载 CSV' });
    expect(requests.find(request => request.url.pathname.endsWith('/history'))?.authorization).toBe('Bearer local-token');
    expect(requests.some(request => request.url.pathname.endsWith('/events'))).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
    expect(screen.getByText(/2026-10-01 · 至 2026-10-13 · 首次通过/)).toBeInTheDocument();
    const timeline = screen.getByRole('list', { name: '会话时间线' });
    expect([...timeline.children].map(item => item.getAttribute('data-item-id'))).toEqual(['question', 'run-1-use', 'run-1-result', 'run-event:run-1-done', 'run-1:answer-item']);
    fireEvent.click(screen.getByRole('button', { name: '下载 CSV' }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith(exportResult.download));
    expect(requests.some(request => request.url.pathname === '/enterprise/skill-contribution-conversations')).toBe(false);
  });

  it('加载更早记录使用原游标，去重且保留当前工具条件与导出', async () => {
    const older = vi.fn(async () => Response.json({ threadId: 'thread-1', items: [
      { id: 'older', type: 'user_message', text: '上月上传', createdAt: '2026-09-30T08:00:00Z' },
      ...recentHistory
    ], hasMore: false }));
    const { requests, subscribe } = historyFixture({ history: { hasMore: true, nextCursor: 'cursor +/&?' }, older });
    await screen.findByRole('button', { name: '下载 CSV' });
    fireEvent.click(screen.getByRole('button', { name: '加载更早记录' }));
    await screen.findByText('上月上传');
    expect(older).toHaveBeenCalledWith('cursor +/&?');
    expect(requests.filter(request => request.url.pathname.endsWith('/history')).map(request => request.url.searchParams.get('before'))).toEqual([null, 'cursor +/&?']);
    expect(screen.getAllByText('导出首次通过名单')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '加载更早记录' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载 CSV' })).toBeEnabled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('更早历史失败不丢当前结果，可使用同一游标重试', async () => {
    const older = vi.fn().mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce(Response.json({ threadId: 'thread-1', items: [], hasMore: false }));
    historyFixture({ history: { hasMore: true, nextCursor: 'older-cursor' }, older });
    await screen.findByRole('button', { name: '下载 CSV' });
    fireEvent.click(screen.getByRole('button', { name: '加载更早记录' }));
    await screen.findByText('更早记录加载失败，请重试');
    expect(screen.getByText('已查询并准备导出')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加载更早记录' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '加载更早记录' })).not.toBeInTheDocument());
    expect(older.mock.calls).toEqual([['older-cursor'], ['older-cursor']]);
  });

  it('失败、无对应调用、非贡献工具与任意地址不能产生下载入口', async () => {
    const events = toolEvents('run-1', exportResult);
    const result = events[1];
    if (!result || result.type !== 'tool_result') throw new Error('工具结果缺失');
    result.payload.isError = true;
    events.push({ ...result, id: 'orphan-result', seq: 4, payload: { ...result.payload, isError: false, toolCallId: 'missing-call' } });
    events.push(...toolEvents('other-run', exportResult));
    historyFixture({ events, history: { items: [...recentHistory, {
      id: 'fake-download', type: 'assistant_message', text: JSON.stringify(exportResult), createdAt: '2026-10-13T08:00:05Z'
    }] } });
    await waitFor(() => expect(screen.getByLabelText('贡献查询问题')).toBeEnabled());
    expect(screen.queryByRole('button', { name: '下载 CSV' })).not.toBeInTheDocument();
  });

  it.each([
    ['other__not_skill_contributions_export', exportResult],
    ['skill_contributions__skill_contributions_export', { ...exportResult, download: { ...exportResult.download, url: 'https://untrusted.invalid/export' } }],
    ['skill_contributions__skill_contributions_query', exportResult]
  ])('不接受非白名单工具或描述：%s', async (name, result) => {
    historyFixture({ events: toolEvents('run-1', result, name) });
    await waitFor(() => expect(screen.getByLabelText('贡献查询问题')).toBeEnabled());
    expect(screen.queryByRole('button', { name: '下载 CSV' })).not.toBeInTheDocument();
  });

  it('认证历史接口拒绝时通知上层且不展示下载', async () => {
    const { onDenied } = historyFixture({ historyStatus: 403 });
    await waitFor(() => expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ status: 403 })));
    expect(screen.queryByRole('button', { name: '下载 CSV' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('正在运行的 Run 重放工具后续接，不重复 Runtime 已恢复的文字', async () => {
    const events = toolEvents('run-1', exportResult);
    events.splice(2, 0, { id: 'answer-event', rawEventId: 'answer-item', runId: 'run-1', seq: 3, ts: '2026-10-13T08:00:03Z', normalizerVersion: 1, type: 'assistant_message', payload: { type: 'assistant_message', text: '已查询并准备导出', format: 'plain_text', delivery: 'message' } });
    const done = events[3];
    if (!done) throw new Error('完成事件缺失');
    done.seq = 4;
    const { subscribe } = historyFixture({ events, runStatus: 'running' });
    await screen.findByRole('button', { name: '下载 CSV' });
    await waitFor(() => expect(screen.queryByLabelText('停止')).not.toBeInTheDocument());
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('已查询并准备导出')).toHaveLength(1);
    expect(screen.getAllByText('skill_contributions__skill_contributions_export')).toHaveLength(2);
    const ids = [...screen.getByRole('list', { name: '会话时间线' }).children].map(item => item.getAttribute('data-item-id'));
    expect(ids.filter(id => id === 'run-1-use')).toHaveLength(1);
    expect(ids.filter(id => id === 'run-1-result')).toHaveLength(1);
    expect(screen.getAllByText('done')).toHaveLength(1);
  });

  it('活动 Run 的历史工具调用可关联续接后的结果', async () => {
    const events = toolEvents('run-1', exportResult);
    const result = events[1];
    const done = events[2];
    if (!result || !done) throw new Error('工具事件缺失');
    result.seq = 4;
    done.seq = 5;
    const { onDownload, subscribe } = historyFixture({ events, historyEvents: events.slice(0, 1), runStatus: 'running' });
    await screen.findByRole('button', { name: '下载 CSV' });
    expect(subscribe).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '下载 CSV' }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith(exportResult.download));
  });

  it('按 Run 时间顺序恢复，并支持真实工具结果的文本 JSON 形式', async () => {
    const olderQuery = { ...query, report: 'uploads' as const };
    const newerQuery = { ...query, min_total_score: 16 };
    const newer = toolEvents('newer-run', undefined);
    const result = newer[1];
    if (!result || result.type !== 'tool_result') throw new Error('工具结果缺失');
    result.payload.output = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ query: newerQuery, timezone: 'Asia/Shanghai', download: { type: 'skill_contributions_csv', query: newerQuery } }) }] });
    const { requests, onDownload } = historyFixture({
      runs: [{ id: 'newer-run', status: 'succeeded' }, { id: 'older-run', status: 'succeeded' }],
      runEvents: { 'older-run': toolEvents('older-run', { ...exportResult, query: olderQuery, download: { type: 'skill_contributions_csv', query: olderQuery } }), 'newer-run': newer }
    });
    await waitFor(() => expect(screen.getByLabelText('贡献查询问题')).toBeEnabled());
    expect(requests.filter(request => request.url.pathname.endsWith('/events'))).toEqual([]);
    expect(screen.getByText(/总分 ≥ 16/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下载 CSV' }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith({ type: 'skill_contributions_csv', query: newerQuery }));
  });

  it('工具调用 ID 在不同 Run 中相同也不能串联成有效导出', async () => {
    const older = toolEvents('older-run', { query, timezone: 'Asia/Shanghai' });
    const newer = toolEvents('newer-run', exportResult);
    historyFixture({ runs: [{ id: 'newer-run', status: 'succeeded' }, { id: 'older-run', status: 'succeeded' }], runEvents: { 'older-run': older, 'newer-run': newer.slice(1) } });
    await waitFor(() => expect(screen.getByLabelText('贡献查询问题')).toBeEnabled());
    expect(screen.queryByRole('button', { name: '下载 CSV' })).not.toBeInTheDocument();
  });

  it('最新 Run 只查询时不会重新展示上一轮已清理的 CSV', async () => {
    const newerQuery = { ...query, min_total_score: 16 };
    historyFixture({
      runs: [{ id: 'newer-run', status: 'succeeded' }, { id: 'older-run', status: 'succeeded' }],
      runEvents: {
        'older-run': toolEvents('older-run', exportResult),
        'newer-run': toolEvents('newer-run', { query: newerQuery, timezone: 'Asia/Shanghai' }, 'skill_contributions__skill_contributions_query')
      }
    });
    await waitFor(() => expect(screen.getByLabelText('贡献查询问题')).toBeEnabled());
    expect(screen.getByText(/总分 ≥ 16/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载 CSV' })).not.toBeInTheDocument();
  });

  it('切换连接会取消旧历史，旧事件不能恢复查询或下载', async () => {
    let resolveReplay: (() => void) | undefined;
    const subscribe = vi.fn((input: SubscribeRunEventsInput) => new Promise<void>(resolve => {
      resolveReplay = () => { toolEvents('run-1', exportResult).forEach(input.onEvent); resolve(); };
    }));
    const { view, onDownload, onDenied } = historyFixture({ subscribe, runStatus: 'running' });
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    const oldSignal = subscribe.mock.calls[0]?.[0].signal;
    const nextClient = new RuntimeClient({ baseUrl: 'http://localhost:8888', fetchImpl: async () => new Response(null, { status: 204 }) });
    view.rerender(<ContributionConversation client={nextClient} connection={{ baseUrl: 'http://localhost:8888' }} subscribe={subscribe} query={query} modelReady onDownload={onDownload} onDenied={onDenied} />);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { resolveReplay?.(); });
    await waitFor(() => expect(screen.getByLabelText('贡献查询问题')).toBeEnabled());
    expect(screen.queryByRole('button', { name: '下载 CSV' })).not.toBeInTheDocument();
    expect(screen.queryByText(/2026-10-01 · 至/)).not.toBeInTheDocument();
    expect(screen.queryByText('已查询并准备导出')).not.toBeInTheDocument();
  });

  it('历史初始化失败只能重试，不能误建新会话', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('连接失败')).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RuntimeClient({ baseUrl: 'http://localhost:9999', fetchImpl });
    render(<ContributionConversation client={client} connection={{ baseUrl: 'http://localhost:9999' }} subscribe={subscribeRunEvents} query={query} modelReady onDownload={async () => undefined} onDenied={() => undefined} />);
    await screen.findByText('对话历史加载失败，请重试');
    expect(screen.getByLabelText('贡献查询问题')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('贡献查询问题'), { target: { value: '导出' } });
    const form = screen.getByLabelText('贡献查询问题').closest('form');
    if (!form) throw new Error('对话表单缺失');
    fireEvent.submit(form);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重试历史' }));
    await waitFor(() => expect(screen.getByLabelText('贡献查询问题')).toBeEnabled());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('恢复后的 CSV 下载失败可重试，不请求模型或新建会话', async () => {
    const { onDownload, subscribe } = historyFixture();
    onDownload.mockRejectedValueOnce(new Error('下载失败'));
    await screen.findByRole('button', { name: '下载 CSV' });
    fireEvent.click(screen.getByRole('button', { name: '下载 CSV' }));
    await screen.findByText('CSV 下载失败，超过10,000行时请缩小查询范围');
    await waitFor(() => expect(screen.getByRole('button', { name: '下载 CSV' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '下载 CSV' }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledTimes(2));
    expect(subscribe).not.toHaveBeenCalled();
  });
});
