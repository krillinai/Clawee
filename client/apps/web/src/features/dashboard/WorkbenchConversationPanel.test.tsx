import type { AgentEventEnvelope, RunResponse, ThreadResponse } from '@clawee/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeClient } from '../../runtime/client.js';
import type { SubscribeRunEventsInput } from '../../runtime/sse.js';
import { createWorkbenchDashboard } from '../../test/workbench-fixtures.js';
import { WorkbenchConversationPanel } from './WorkbenchConversationPanel.js';
import { buildBilibiliModuleContext, type WorkbenchModuleContext } from './workbench-module-context.js';
import type { WorkbenchConversationRuntime } from './use-workbench-conversation.js';

vi.mock('react-virtuoso', async () => import('../../test/react-virtuoso-mock.js'));

const thread: ThreadResponse = {
  id: 'thread_1', title: '看板对话', projectId: 'project_1', origin: 'clawee_created', cwd: '/workspace/project_1',
  canonicalCwd: '/workspace/project_1', workspaceMode: 'external', profile: 'default', sandbox: 'read-only',
  status: 'active', purpose: 'conversation', createdAt: '2026-08-30T01:30:00Z', updatedAt: '2026-08-30T01:30:00Z'
};

function createRuntime() {
  const requests: Array<{ url: string; method?: string; body?: Record<string, unknown> }> = [];
  const subscriptions: SubscribeRunEventsInput[] = [];
  const control = { failNextRun: false, restoreActive: false, directoryUnavailable: false };
  let runCount = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ url, method: init?.method, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
      headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/threads') && init?.method === 'POST') {
      if (control.directoryUnavailable) return json({ error: {
        code: 'PROJECT_DIRECTORY_UNAVAILABLE', message: 'Project directory does not exist or is not accessible'
      } }, 400);
      return json({ thread }, 201);
    }
    if (url.includes('/history')) return json({ threadId: thread.id, items: [], hasMore: false });
    if (url.includes('/threads/thread_1/runs')) return json({ runs: control.restoreActive ? [{ id: 'run_1', threadId: thread.id, status: 'running' }] : [] });
    if (url.includes('/approvals?')) return json({ approvals: [] });
    if (url.endsWith('/runs') && init?.method === 'POST') {
      if (control.failNextRun) { control.failNextRun = false; return json({ error: { code: 'RUN_FAILED', message: '发送失败' } }, 503); }
      runCount += 1;
      return json({ id: `run_${runCount}`, threadId: thread.id, status: 'running' } satisfies RunResponse, 202);
    }
    if (url.endsWith('/cancel')) return json({ id: 'run_1', canceled: true }, 202);
    throw new Error(`Unexpected request: ${url}`);
  });
  const subscribeRunEvents = vi.fn(async (input: SubscribeRunEventsInput) => {
    subscriptions.push(input);
    await new Promise<void>(resolve => { input.signal?.addEventListener('abort', () => resolve(), { once: true }); });
  });
  const runtime: WorkbenchConversationRuntime = {
    client: new RuntimeClient({ baseUrl: 'http://runtime.test', fetchImpl }), connection: { baseUrl: 'http://runtime.test' },
    connected: true, subjectId: 'member_1', project: { id: 'project_1', name: 'Project One', cwd: '/workspace/project_1',
      sandbox: 'workspace-write', profile: 'default', model: null, reasoning: null },
    config: { permission: 'workspace-write', profile: 'default', model: 'model_1', reasoning: null },
    fetchImpl, subscribeRunEvents
  };
  return { runtime, requests, subscriptions, control };
}

function context() {
  return buildBilibiliModuleContext({ status: 'loaded', dashboard: createWorkbenchDashboard() }, { range: '7d', sourceId: 'bdsrc_1' });
}

function PanelHarness(props: { runtime: WorkbenchConversationRuntime; context: WorkbenchModuleContext; initialThreadId?: string }) {
  const [threadId, setThreadId] = useState(props.initialThreadId);
  return <WorkbenchConversationPanel runtime={props.runtime} context={props.context} threadId={threadId}
    onThreadCreated={created => setThreadId(created.id)} />;
}

function emit(input: SubscribeRunEventsInput, seq: number, payload: AgentEventEnvelope['payload']) {
  input.onEvent({ id: `${input.runId}_${seq}`, runId: input.runId, seq, ts: '2026-08-30T01:30:00Z',
    type: payload.type, payload, normalizerVersion: 1 } as AgentEventEnvelope);
}

describe('WorkbenchConversationPanel', () => {
  it('blocks a missing project directory and offers default project recovery without invoking the model', async () => {
    const user = userEvent.setup();
    const testRuntime = createRuntime();
    const onUseDefaultProject = vi.fn(async () => {});
    const runtime = { ...testRuntime.runtime, project: { ...testRuntime.runtime.project!, directoryState: 'missing' as const }, onUseDefaultProject };
    const view = render(<PanelHarness runtime={runtime} context={context()} />);
    expect(screen.getByRole('textbox', { name: '输入任务' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('/workspace/project_1');
    expect(screen.queryByRole('button', { name: '重试连接' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '使用默认项目' }));
    expect(onUseDefaultProject).toHaveBeenCalledOnce();
    expect(testRuntime.requests).toHaveLength(0);
    view.rerender(<PanelHarness runtime={{ ...runtime, project: { ...runtime.project, directoryState: 'available' } }} context={context()} />);
    expect(screen.getByRole('textbox', { name: '输入任务' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves the failed draft and repairs a directory that disappeared after projects were loaded', async () => {
    const user = userEvent.setup();
    const testRuntime = createRuntime();
    testRuntime.control.directoryUnavailable = true;
    const onUseDefaultProject = vi.fn(async () => { testRuntime.control.directoryUnavailable = false; });
    render(<PanelHarness runtime={{ ...testRuntime.runtime, onUseDefaultProject }} context={context()} />);
    await user.type(screen.getByRole('textbox', { name: '输入任务' }), '分析当前数据');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('重新连接不能修复目录');
    expect(screen.getByRole('textbox', { name: '输入任务' })).toHaveValue('分析当前数据');
    expect(screen.getByRole('textbox', { name: '输入任务' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '重试连接' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '使用默认项目' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入任务' })).toBeEnabled());
    expect(onUseDefaultProject).toHaveBeenCalledOnce();
    expect(testRuntime.requests.some(request => request.url.endsWith('/runs'))).toBe(false);
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(testRuntime.subscriptions).toHaveLength(1));
    expect(testRuntime.requests.find(request => request.url.endsWith('/runs'))!.body!.prompt).toBe('分析当前数据');
  });

  it('keeps directory recovery available when preparing the default project fails', async () => {
    const user = userEvent.setup();
    const testRuntime = createRuntime();
    const onUseDefaultProject = vi.fn(async () => { throw new Error('无法创建默认项目目录'); });
    render(<PanelHarness runtime={{ ...testRuntime.runtime, project: { ...testRuntime.runtime.project!, directoryState: 'missing' }, onUseDefaultProject }} context={context()} />);
    await user.click(screen.getByRole('button', { name: '使用默认项目' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法创建默认项目目录');
    expect(screen.getByRole('button', { name: '使用默认项目' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: '输入任务' })).toBeDisabled();
    expect(testRuntime.requests).toHaveLength(0);
  });

  it('does not invoke the model on open, sends data separately, streams replies and reuses the thread', async () => {
    const user = userEvent.setup();
    const testRuntime = createRuntime();
    const view = render(<PanelHarness runtime={testRuntime.runtime} context={context()} />);
    const panel = screen.getByLabelText('模块对话');
    expect(within(panel).getByText('品牌官方账号 · 近 7 天')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: '只读分析权限' })).toBeDisabled();
    expect(testRuntime.requests).toHaveLength(0);
    await user.type(within(panel).getByRole('textbox', { name: '输入任务' }), '分析增长趋势');
    await user.click(within(panel).getByRole('button', { name: '发送' }));
    await waitFor(() => expect(testRuntime.subscriptions).toHaveLength(1));
    const created = testRuntime.requests.find(request => request.url.endsWith('/threads'))!;
    expect(created.body).toMatchObject({ projectId: 'project_1', sandbox: 'read-only', model: 'model_1' });
    const submitted = testRuntime.requests.find(request => request.url.endsWith('/runs'))!;
    expect(submitted.body).toMatchObject({ threadId: 'thread_1', prompt: '分析增长趋势', model: 'model_1' });
    expect(JSON.parse(submitted.body!.workbenchContext as string)).toMatchObject({ range: '7d', data: { followerCount: 128600 } });
    expect(within(panel).getByText('分析增长趋势')).toBeInTheDocument();
    expect(within(panel).queryByText(/"followerCount"/)).not.toBeInTheDocument();
    act(() => {
      emit(testRuntime.subscriptions[0]!, 1, { type: 'assistant_message', text: '账号粉丝呈增长趋势。', format: 'plain_text', delivery: 'message' });
      emit(testRuntime.subscriptions[0]!, 2, { type: 'done', status: 'succeeded', terminationReason: 'completed' });
    });
    expect(await within(panel).findByText('账号粉丝呈增长趋势。')).toBeInTheDocument();
    await waitFor(() => expect(within(panel).getByRole('textbox', { name: '输入任务' })).toBeEnabled());
    const nextContext = buildBilibiliModuleContext({ status: 'loaded', dashboard: createWorkbenchDashboard('30d') }, { range: '30d', sourceId: 'bdsrc_1' });
    view.rerender(<PanelHarness runtime={testRuntime.runtime} context={nextContext} />);
    await user.type(within(panel).getByRole('textbox', { name: '输入任务' }), '再分析近30天');
    await user.click(within(panel).getByRole('button', { name: '发送' }));
    await waitFor(() => expect(testRuntime.subscriptions).toHaveLength(2));
    expect(testRuntime.requests.filter(request => request.url.endsWith('/threads'))).toHaveLength(1);
    const runs = testRuntime.requests.filter(request => request.url.endsWith('/runs'));
    expect(JSON.parse(runs[1]!.body!.workbenchContext as string).range).toBe('30d');
  });

  it('blocks unavailable data and disconnected runtimes instead of sending stale snapshots', () => {
    const testRuntime = createRuntime();
    const unavailable = buildBilibiliModuleContext({ status: 'loading' }, { range: '30d' });
    const view = render(<PanelHarness runtime={testRuntime.runtime} context={unavailable} />);
    expect(screen.getByRole('textbox', { name: '输入任务' })).toBeDisabled();
    expect(screen.getByText('当前看板数据尚不可用，加载完成后可发送消息。')).toBeInTheDocument();
    view.rerender(<PanelHarness runtime={{ ...testRuntime.runtime, connected: false }} context={context()} />);
    expect(screen.getByRole('textbox', { name: '输入任务' })).toBeDisabled();
    expect(testRuntime.requests).toHaveLength(0);
  });

  it('keeps the draft after send failure and can retry without creating a second thread', async () => {
    const user = userEvent.setup();
    const testRuntime = createRuntime();
    testRuntime.control.failNextRun = true;
    render(<PanelHarness runtime={testRuntime.runtime} context={context()} />);
    await user.type(screen.getByRole('textbox', { name: '输入任务' }), '请分析数据');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('发送失败');
    expect(screen.getByRole('textbox', { name: '输入任务' })).toHaveValue('请分析数据');
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入任务' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(testRuntime.subscriptions).toHaveLength(1));
    expect(testRuntime.requests.filter(request => request.url.endsWith('/threads'))).toHaveLength(1);
  });

  it('stops the current run and restores the ability to ask another question', async () => {
    const user = userEvent.setup();
    const testRuntime = createRuntime();
    render(<PanelHarness runtime={testRuntime.runtime} context={context()} />);
    await user.type(screen.getByRole('textbox', { name: '输入任务' }), '分析数据');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(testRuntime.subscriptions).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: '停止任务' }));
    expect(testRuntime.requests.some(request => request.url.endsWith('/runs/run_1/cancel'))).toBe(true);
    act(() => { emit(testRuntime.subscriptions[0]!, 1, { type: 'done', status: 'canceled', terminationReason: 'user_canceled' }); });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入任务' })).toBeEnabled());
  });

  it('reattaches to the existing active run when reopening the module', async () => {
    const testRuntime = createRuntime();
    testRuntime.control.restoreActive = true;
    const view = render(<PanelHarness initialThreadId="thread_1" runtime={testRuntime.runtime} context={context()} />);
    await waitFor(() => expect(testRuntime.subscriptions).toHaveLength(1));
    expect(testRuntime.subscriptions[0]!.runId).toBe('run_1');
    expect(testRuntime.requests.some(request => request.method === 'POST')).toBe(false);
    view.unmount();
    expect(testRuntime.subscriptions[0]!.signal?.aborted).toBe(true);
    expect(testRuntime.requests.some(request => request.url.endsWith('/cancel'))).toBe(false);
  });
});
