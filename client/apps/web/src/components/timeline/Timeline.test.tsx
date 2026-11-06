import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline.js';
import type { TimelineItem } from './timeline-model.js';
import { mapHistoryItemsToTimelineItems } from './history-mapping.js';
import { eventToTimelineItem } from './timeline-model.js';

vi.mock('react-virtuoso', async () => import('../../test/react-virtuoso-mock.js'));

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe('Timeline', () => {
  it('选中回复的一部分后显示引用按钮，并传递准确的原文', async () => {
    const onQuote = vi.fn();
    render(<Timeline items={[{ kind: 'assistant_message', id: 'quote', text: '前文需要引用的文字后文', source: 'runtime' }]}
      onQuote={onQuote} />);
    const node = screen.getByText('前文需要引用的文字后文').firstChild!;
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 9);
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => new DOMRect(100, 50, 120, 20) });
    act(() => { window.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    const quote = screen.getByRole('button', { name: '引用' });
    expect(fireEvent.mouseDown(quote)).toBe(false);
    await userEvent.setup().click(quote);
    expect(onQuote).toHaveBeenCalledWith('需要引用的文字');
    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(screen.queryByRole('button', { name: '引用' })).not.toBeInTheDocument();
  });

  it('用户消息和跨回复选区不展示引用入口，取消选区后关闭按钮', () => {
    const { container } = render(<Timeline items={[
      { kind: 'user_message', id: 'user-quote', text: '用户问题', source: 'runtime' },
      { kind: 'assistant_message', id: 'quote-1', text: '第一段回复', source: 'runtime' },
      { kind: 'assistant_message', id: 'quote-2', text: '第二段回复', source: 'runtime' }
    ]} onQuote={vi.fn()} />);
    const select = (start: Node, end = start) => {
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent!.length);
      Object.defineProperty(range, 'getBoundingClientRect', { value: () => new DOMRect(100, 50, 120, 20) });
      act(() => { window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
        document.dispatchEvent(new Event('selectionchange')); });
    };
    select(container.querySelector('.markdown-prose[data-variant="user"] p')!.firstChild!);
    expect(screen.queryByRole('button', { name: '引用' })).not.toBeInTheDocument();
    select(screen.getByText('第一段回复').firstChild!, screen.getByText('第二段回复').firstChild!);
    expect(screen.queryByRole('button', { name: '引用' })).not.toBeInTheDocument();
    select(screen.getByText('第一段回复').firstChild!);
    expect(screen.getByRole('button', { name: '引用' })).toBeInTheDocument();
    act(() => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
    expect(screen.queryByRole('button', { name: '引用' })).not.toBeInTheDocument();
  });

  it.each(['Escape', 'scroll', 'conversation'])('%s 时关闭引用按钮，避免引用旧选区', reason => {
    const items: TimelineItem[] = [{ kind: 'assistant_message', id: 'quote', text: '选中的回复', source: 'runtime' }];
    const onQuote = vi.fn();
    const { rerender } = render(<Timeline items={items} conversationKey="first" onQuote={onQuote} />);
    const range = document.createRange();
    range.selectNodeContents(screen.getByText('选中的回复'));
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => new DOMRect(100, 50, 120, 20) });
    act(() => { window.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    expect(screen.getByRole('button', { name: '引用' })).toBeInTheDocument();
    if (reason === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
    else if (reason === 'scroll') fireEvent.scroll(document.querySelector('.timeline-virtuoso')!);
    else rerender(<Timeline items={items} conversationKey="second" onQuote={onQuote} />);
    expect(screen.queryByRole('button', { name: '引用' })).not.toBeInTheDocument();
    expect(onQuote).not.toHaveBeenCalled();
  });

  it.each([undefined, 'run_warning'])('直接展示旧配置告警的摘要、详情和路径（运行：%s）', runId => {
    const item = eventToTimelineItem({ id: 'warning', runId: 'run_warning', seq: 1, ts: '2026-10-21T00:00:00Z', normalizerVersion: 2,
      type: 'diagnostic', payload: { type: 'diagnostic', code: 'CODEX_WARNING', severity: 'warning', message: 'Codex warning',
        details: { raw: { summary: '配置项已弃用', details: '请改用新的配置项。\nAPI_KEY=sk-warning-secret', path: '/runtime/config.toml', range: null } } } });
    if (item?.kind !== 'diagnostic') throw new Error('告警事件未生成诊断项');
    render(<Timeline items={[{ ...item, runId }]} />);
    expect(screen.getByText('配置项已弃用')).toBeVisible();
    expect(screen.getByText(/请改用新的配置项。/)).toBeVisible();
    expect(screen.getByText('配置文件：/runtime/config.toml')).toBeVisible();
    expect(screen.queryByText('Codex warning')).not.toBeInTheDocument();
    expect(screen.queryByText(/sk-warning-secret/)).not.toBeInTheDocument();
    expect(screen.getByText(/API_KEY=\[REDACTED\]/)).toBeVisible();
  });

  it('没有附加详情的普通告警仍只展示原消息', () => {
    render(<Timeline items={[{ kind: 'diagnostic', id: 'warning', runId: 'run_warning', severity: 'warning', message: '运行环境权限受限',
      content: JSON.stringify({ details: { raw: { message: '运行环境权限受限', threadId: 'thread_warning' } } }), source: 'runtime' }]} />);
    expect(screen.getByText('运行环境权限受限')).toBeVisible();
    expect(screen.queryByText(/配置文件：/)).not.toBeInTheDocument();
  });

  it('直接显示 Codex 异常来源与底层错误，无需展开技术详情', () => {
    const error: TimelineItem = { kind: 'diagnostic', id: 'protection', runId: 'run_protection', source: 'runtime', severity: 'error', message: 'error', content: '{}',
      modelResponse: { errorCode: 'other', reason: 'Codex Runtime 返回错误', suggestion: '请稍后重试', retrying: false, diagnostics: {},
        runtimeMessage: 'Response protection failed: could not validate the response', runtimeDetails: 'Unexpected response event from model provider' } };
    render(<Timeline items={[error]} />);
    expect(screen.getByText('异常来源：Codex Runtime（模型执行层）')).toBeVisible();
    expect(screen.getByText('Response protection failed: could not validate the response')).toBeVisible();
    expect(screen.getByText('Unexpected response event from model provider')).toBeVisible();
    expect(screen.getByText('本次任务失败；最后已知原因：Codex Runtime 返回错误')).toBeVisible();
  });
  it('成功任务仍展示已恢复提示，不自动折叠故障结果', () => {
    const retry: TimelineItem = { kind: 'diagnostic', id: 'retry', runId: 'run_recovered', source: 'runtime', severity: 'warning', message: 'retry', content: '{}',
      modelResponse: { errorCode: 'responseStreamDisconnected', reason: '模型响应连接中断，具体原因未返回', suggestion: '请联系管理员', retrying: true, diagnostics: {} } };
    render(<Timeline items={[retry,
      { kind: 'assistant_message', id: 'answer', runId: 'run_recovered', text: '模型回答', source: 'runtime' },
      { kind: 'done', id: 'done', runId: 'run_recovered', status: 'succeeded', terminationReason: 'completed', content: '{}', source: 'runtime' }
    ]} />);
    expect(screen.getByText('模型响应已恢复，任务继续执行')).toBeVisible();
    expect(screen.getByText('模型回答')).toBeVisible();
  });
  it('重试提示合并且在失败后保留具体原因、操作建议和排查编号', () => {
    const retry: TimelineItem = { kind: 'diagnostic', id: 'retry_1', runId: 'run_model', source: 'runtime', severity: 'warning', message: 'retry', content: '{}',
      modelResponse: { errorCode: 'responseStreamDisconnected', reason: '模型接口返回限流（HTTP 429）', suggestion: '请稍后重试', retrying: true,
        retryAttempt: 1, retryLimit: 5, httpStatus: 429, requestId: 'req_model', diagnostics: { additional_details: 'HTTP 429' } } };
    const { container, rerender } = render(<Timeline items={[retry, { ...retry, id: 'retry_2' }]} />);
    expect(container.querySelectorAll('.model-response-diagnostic')).toHaveLength(1);
    expect(screen.getByText('模型接口返回限流（HTTP 429），正在重试（1/5）')).toBeInTheDocument();
    const failed: TimelineItem = { kind: 'done', id: 'done', runId: 'run_model', status: 'failed', terminationReason: 'stream_error', content: '{}', source: 'runtime' };
    rerender(<Timeline items={[retry, { ...retry, id: 'retry_2' }, failed]} />);
    expect(container.querySelectorAll('.model-response-diagnostic')).toHaveLength(1);
    expect(screen.getByText('本次任务失败；最后已知原因：模型接口返回限流（HTTP 429）')).toBeInTheDocument();
    expect(screen.getByText('请稍后重试')).toBeInTheDocument();
    fireEvent.click(screen.getByText('技术详情'));
    expect(screen.getByText('排查编号：run_model')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制排查编号' })).toBeInTheDocument();
    expect(screen.queryByText('异常已上报')).not.toBeInTheDocument();
  });

  it('shows workflow context and confirmed node synchronization separately', () => {
    render(<Timeline items={[
      {
        kind: 'workflow_start', id: 'workflow-start:run-1', runId: 'run-1', taskId: 'task-1',
        instanceId: 'instance-1', workflowName: '每日热点', nodeTitle: '热点整理',
        nodeOrder: 0, instruction: '选出最值得读的三条新闻', input: '今天的 AI 新闻',
        timestamp: '2026-09-22T00:00:00.000Z', source: 'runtime'
      },
      {
        kind: 'workflow_status', id: 'workflow-status:run-1', runId: 'run-1', taskId: 'task-1',
        status: 'completed', timestamp: '2026-09-22T00:01:00.000Z', source: 'runtime'
      }
    ]} />);
    expect(screen.getByText('每日热点 · 热点整理')).toBeInTheDocument();
    expect(screen.getByText('选出最值得读的三条新闻')).toBeInTheDocument();
    expect(screen.getByText('今天的 AI 新闻')).toBeInTheDocument();
    expect(screen.getByText('任务要求')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('节点已完成');
  });

  it.each([
    undefined,
    { handledBy: 'user-b' },
    { handledBy: 'user-b', handledByName: '李四' }
  ])('完成消息兼容旧历史且只展示已确认的处理人名称：%j', completion => {
    render(<Timeline items={mapHistoryItemsToTimelineItems([{
      type: 'workflow_status', id: 'workflow-status:run-1', runId: 'run-1', taskId: 'task-1',
      status: 'completed', completion, createdAt: '2026-10-15T00:00:00.000Z'
    }])} />);
    expect(screen.getByRole('status')).toHaveTextContent('节点已完成');
    if (completion?.handledByName) {
      expect(screen.getByText('处理人：李四')).toBeInTheDocument();
    } else {
      expect(screen.queryByText(/处理人：/)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/user-b|昵称不可用/)).not.toBeInTheDocument();
  });

  it('renders and targets a public schedule trigger without exposing execution rules', () => {
    const { container } = render(
      <Timeline
        items={[{
          kind: 'schedule_trigger',
          id: 'schedule-trigger-1',
          runId: 'run_schedule',
          prompt: '生成每日项目摘要',
          triggeredAt: '2026-07-14T14:05:00.000Z',
          source: 'runtime'
        }]}
        targetRunId="run_schedule"
      />
    );

    expect(screen.getByText('定时执行')).toBeInTheDocument();
    expect(screen.getByText('生成每日项目摘要')).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    expect(screen.queryByText(/立即完成本次任务/)).not.toBeInTheDocument();
    expect(container.querySelector('[data-search-target="true"]')).toHaveTextContent(
      '生成每日项目摘要'
    );
  });

  it('excludes pending approvals from the timeline without scrolling it', () => {
    const { container } = render(
      <Timeline
        items={[{
          kind: 'approval',
          id: 'event_approval_visible',
          runId: 'run_visible',
          approval: {
            id: 'approval_visible',
            runId: 'run_visible',
            threadId: 'thread_visible',
            turnId: 'turn_visible',
            itemId: 'item_visible',
            requestId: 'rpc_visible',
            kind: 'command_execution',
            status: 'pending',
            risk: 'high',
            title: '允许执行命令',
            summary: '运行较长命令',
            details: {
              command: 'pnpm test --filter web && pnpm build --filter desktop',
              cwd: '/workspace'
            },
            requestedAt: '2026-07-24T10:00:00.000Z',
            expiresAt: '2026-07-24T10:10:00.000Z'
          },
          source: 'runtime'
        }]}
      />
    );

    expect(container.querySelector('.timeline-approval-overlay')).not.toBeInTheDocument();
    expect(screen.queryByText('允许 Clawee 执行这条命令？')).not.toBeInTheDocument();
    expect(container.querySelector('.timeline-approval')).not.toBeInTheDocument();
    expect(screen.getByTestId('virtuoso-scroller').scrollTop).toBe(0);
  });

  it.each(['approved', 'rejected', 'expired', 'canceled'] as const)(
    'collapses %s approval cards into a lightweight resolution row',
    (status) => {
      const { container } = render(
        <Timeline
          items={[{
            kind: 'approval',
            id: `event_approval_${status}`,
            runId: 'run_resolved',
            approval: {
              id: `approval_${status}`,
              runId: 'run_resolved',
              threadId: 'thread_resolved',
              turnId: 'turn_resolved',
              itemId: 'item_resolved',
              requestId: 'rpc_resolved',
              kind: 'command_execution',
              status,
              risk: 'high',
              title: '已处理的审批',
              summary: '不应继续显示',
              details: { command: 'pnpm test', cwd: '/workspace' },
              requestedAt: '2026-07-24T10:00:00.000Z',
              expiresAt: '2026-07-24T10:10:00.000Z'
            },
            source: 'runtime'
          }]}
        />
      );

      expect(screen.queryByText('已处理的审批')).not.toBeInTheDocument();
      expect(screen.queryByText('不应继续显示')).not.toBeInTheDocument();
      const expected = {
        approved: '已允许执行命令',
        rejected: '已拒绝执行命令',
        expired: '权限申请已过期',
        canceled: '权限申请已取消'
      }[status];
      expect(screen.getByText(expected)).toBeInTheDocument();
      expect(container.querySelector('.timeline-approval-resolved')).toBeInTheDocument();
      expect(container.querySelector('.approval-panel')).not.toBeInTheDocument();
    }
  );

  it('keeps the approved network target in the lightweight approval record', () => {
    render(
      <Timeline
        items={[{
          kind: 'approval',
          id: 'event_approval_network',
          runId: 'run_network',
          approval: {
            id: 'approval_network',
            runId: 'run_network',
            turnId: 'turn_network',
            itemId: 'item_network',
            requestId: 'rpc_network',
            kind: 'permissions',
            status: 'approved',
            risk: 'medium',
            title: '允许访问网站',
            summary: '访问 Apple App Store',
            details: { network: { protocol: 'https', host: 'apps.apple.com' } },
            requestedAt: '2026-07-24T10:00:00.000Z',
            expiresAt: '2026-07-24T10:10:00.000Z'
          },
          source: 'runtime'
        }]}
      />
    );

    expect(screen.getByText('已允许访问 apps.apple.com')).toBeInTheDocument();
  });

  it('renders image metadata and a local preview with the user message', () => {
    render(
      <Timeline
        items={[
          {
            kind: 'user_message',
            id: 'user_with_image',
            text: '描述图片',
            attachments: [{
              id: 'attachment_1',
              fileName: 'screen.png',
              mime: 'image/png',
              size: 2048,
              sha256: 'a'.repeat(64),
              storageKey: 'at/attachment_1.bin',
              threadId: 'thread_1',
              runId: 'run_1',
              status: 'committed',
              createdAt: '2026-07-12T00:00:00.000Z',
              updatedAt: '2026-07-12T00:00:00.000Z'
            }],
            attachmentPreviewUrls: {
              attachment_1: 'blob:screen.png'
            },
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByRole('img', { name: 'screen.png' })).toHaveAttribute(
      'src',
      'blob:screen.png'
    );
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.getByText('描述图片')).toBeInTheDocument();
  });

  it('为未完成预览的图片预留空间，其他附件显示紧凑文件行', () => {
    const { container } = render(
      <Timeline items={[{
        kind: 'user_message',
        id: 'user_files',
        text: '检查文件',
        source: 'runtime',
        attachments: ['pdf', 'docx', 'xlsx', 'png'].map((extension, index) => ({
          id: `file_${index}`,
          fileName: `长文件名称_${extension}.${extension}`,
          mime: extension === 'png' ? 'image/png' : 'application/octet-stream',
          size: 2048,
          sha256: 'a'.repeat(64),
          storageKey: `at/file_${index}.bin`,
          status: 'committed',
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z'
        }))
      }]} />
    );

    expect(container.querySelectorAll('.timeline-message-attachment-compact')).toHaveLength(3);
    expect(container.querySelector('.timeline-message-attachment-placeholder')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    for (const extension of ['pdf', 'docx', 'xlsx', 'png']) {
      expect(screen.getByTitle(`长文件名称_${extension}.${extension}`)).toHaveTextContent(
        `长文件名称_${extension}.${extension}`
      );
      expect(screen.getByText(`.${extension}`)).toBeInTheDocument();
      expect(screen.getByText(extension === 'png' ? '2 KB' : `${extension.toUpperCase()} · 2 KB`)).toBeInTheDocument();
    }
  });

  it('falls back to a compact file row when an image preview fails and retries a new URL', () => {
    const item: Extract<TimelineItem, { kind: 'user_message' }> = {
      kind: 'user_message',
      id: 'user_image_failure',
      text: '检查图片',
      source: 'runtime',
      attachments: [{
        id: 'image_1', fileName: 'screen.png', mime: 'image/png', size: 2048,
        sha256: 'a'.repeat(64), storageKey: 'at/image_1.bin', status: 'committed',
        createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z'
      }],
      attachmentPreviewUrls: { image_1: 'blob:broken' }
    };
    const { container, rerender } = render(<Timeline items={[item]} />);
    fireEvent.error(screen.getByRole('img', { name: 'screen.png' }));

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('.timeline-message-attachment-compact')).toBeInTheDocument();

    rerender(<Timeline items={[{
      ...item, attachmentPreviewUrls: { image_1: 'blob:recovered' }
    }]} />);
    expect(screen.getByRole('img', { name: 'screen.png' })).toHaveAttribute('src', 'blob:recovered');
  });

  it('copies and edits a user message from its action row', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const onEditUserMessage = vi.fn();
    const item: Extract<TimelineItem, { kind: 'user_message' }> = {
      kind: 'user_message',
      id: 'user_actions',
      timestamp: '2026-07-25T12:09:00.000Z',
      text: '重新整理这段需求',
      source: 'runtime'
    };

    render(
      <Timeline
        items={[item]}
        onEditUserMessage={onEditUserMessage}
      />
    );

    const message = screen.getByText('重新整理这段需求').closest('.timeline-user_message');
    const bubble = message?.querySelector<HTMLElement>('.timeline-bubble') ?? null;
    const meta = message?.querySelector<HTMLElement>('.timeline-message-meta') ?? null;
    expect(meta).toBeInTheDocument();
    expect(bubble).not.toContainElement(meta);
    expect(meta?.querySelector('time')).toBeNull();
    const info = screen.getByRole('button', { name: '消息信息' });
    await user.hover(message!);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await user.hover(info);
    expect(screen.getByRole('tooltip')).toHaveAttribute('datetime', item.timestamp);
    expect(screen.getByRole('tooltip')).toHaveTextContent('2026');
    await user.unhover(info);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => info.focus());
    expect(info).toHaveAccessibleDescription(screen.getByRole('tooltip').textContent!);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '复制消息' }));
    expect(writeText).toHaveBeenCalledWith('重新整理这段需求');
    expect(await screen.findByRole('button', { name: '已复制消息' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '编辑消息' }));
    expect(onEditUserMessage).toHaveBeenCalledWith(item);
  });

  it('shows reply actions for assistant messages and marks only the latest reply for default copy access', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const { container } = render(
      <Timeline
        items={[
          {
            kind: 'assistant_message',
            id: 'assistant_old',
            timestamp: '2026-07-25T12:00:00.000Z',
            text: '较早回复',
            source: 'runtime'
          },
          {
            kind: 'assistant_message',
            id: 'assistant_latest',
            timestamp: '2026-07-25T12:09:00.000Z',
            text: '最新回复',
            source: 'runtime'
          }
        ]}
      />
    );

    const replies = container.querySelectorAll('.timeline-assistant_message');
    expect(replies).toHaveLength(2);
    expect(replies[0]?.querySelector('.timeline-message-meta')).not.toHaveClass(
      'is-latest-assistant'
    );
    expect(replies[1]?.querySelector('.timeline-message-meta')).toHaveClass(
      'is-latest-assistant'
    );
    expect(replies[1]?.querySelector('time')).toBeNull();
    const latestReplyMeta = replies[1]?.querySelector('.timeline-message-meta');
    expect(latestReplyMeta?.children[0]).toBe(
      screen.getAllByRole('button', { name: '复制回复' })[1]
    );
    const info = screen.getAllByRole('button', { name: '消息信息' })[1]!;
    await user.click(info);
    expect(screen.getByRole('tooltip')).toHaveAttribute('datetime', '2026-07-25T12:09:00.000Z');
    expect(screen.queryByRole('button', { name: '编辑消息' })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: '复制回复' })[1]!);
    expect(writeText).toHaveBeenCalledWith('最新回复');
    expect(await screen.findByRole('button', { name: '已复制回复' })).toBeInTheDocument();
  });

  it('marks the virtual item that contains a search target', () => {
    const items: TimelineItem[] = [
      {
        kind: 'user_message',
        id: 'message-before',
        text: '前一条',
        source: 'runtime'
      },
      {
        kind: 'assistant_message',
        id: 'target-message',
        text: '目标回复',
        content: '{"type":"assistant_message","text":"目标回复"}',
        source: 'runtime'
      }
    ];

    const { container } = render(
      <Timeline items={items} targetItemId="target-message" />
    );

    expect(
      container.querySelector('.timeline-assistant_message[data-search-target="true"]')
    ).toHaveTextContent('目标回复');
  });

  it('marks the process block that matches a run target', () => {
    const items: TimelineItem[] = [
      {
        kind: 'assistant_message',
        id: 'run-message',
        runId: 'run-target',
        text: '目标运行结果',
        source: 'runtime'
      },
      {
        kind: 'done',
        id: 'run-done',
        runId: 'run-target',
        status: 'succeeded',
        content: '{"type":"done","status":"succeeded"}',
        source: 'runtime'
      }
    ];

    const { container } = render(
      <Timeline items={items} targetRunId="run-target" />
    );

    expect(
      container.querySelector('.timeline-assistant_message[data-search-target="true"]')
    ).toHaveTextContent('目标运行结果');
  });

  it('lists every completed tool call with its command when the process is expanded', async () => {
    const user = userEvent.setup();
    const items: TimelineItem[] = [
      ...Array.from({ length: 50 }, (_, index): TimelineItem => ({
        kind: 'tool_step',
        id: `tool_${index}`,
        runId: 'run_large_history',
        name: 'exec_command',
        content: JSON.stringify({
          type: 'tool_use',
          toolCallId: `call_${index}`,
          name: 'exec_command',
          input: { command: `echo ${index}` }
        }),
        source: 'runtime'
      })),
      {
        kind: 'done',
        id: 'done_large_history',
        runId: 'run_large_history',
        status: 'succeeded',
        content: '{"type":"done","status":"succeeded"}',
        source: 'runtime'
      }
    ];

    const { container } = render(<Timeline items={items} />);

    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(container.querySelectorAll('.process-step')).toHaveLength(0);

    await user.click(screen.getByText('已完成'));

    expect(container.querySelectorAll('.process-step-tools')).toHaveLength(1);
    expect(container.querySelectorAll('.process-tool-call')).toHaveLength(50);
    expect(container.querySelector('.process-tool-group > summary')).toHaveTextContent(/^已运行 echo$/u);
    expect(screen.getByText('echo 49')).toHaveClass('process-step-detail');
  });

  it('renders user and final assistant messages while folding completed run process', async () => {
    const user = userEvent.setup();
    const items: TimelineItem[] = [
      {
        kind: 'user_message',
        id: 'user_1',
        text: 'please inspect the run',
        content: '{"type":"user_message","text":"please inspect the run"}',
        source: 'runtime'
      },
      {
        kind: 'run_status',
        id: 'status_queued',
        runId: 'run_1',
        label: 'queued',
        source: 'runtime'
      },
      {
        kind: 'run_status',
        id: 'status_running',
        runId: 'run_1',
        label: 'running',
        source: 'runtime'
      },
      {
        kind: 'reasoning_summary',
        id: 'reasoning_1',
        runId: 'run_1',
        text: '我会先确认日志里有没有失败信息。\n\n然后根据结果给出结论。',
        source: 'runtime'
      },
      {
        kind: 'assistant_message',
        id: 'assistant_1',
        runId: 'run_1',
        text: 'I am checking the logs',
        content: '{"type":"assistant_message","text":"I am checking the logs"}',
        source: 'runtime'
      },
      {
        kind: 'tool_step',
        id: 'tool_1',
        name: 'exec_command',
        content: '{"type":"tool_use","toolCallId":"call_1","name":"exec_command","input":{"command":"pnpm test"}}',
        source: 'runtime'
      },
      {
        kind: 'tool_step',
        id: 'tool_2',
        name: 'call_1',
        content: '{"type":"tool_result","toolCallId":"call_1","output":"test output","exitCode":0,"isError":false}',
        source: 'runtime'
      },
      {
        kind: 'change_card',
        id: 'change_1',
        title: 'Edited timeline model',
        path: 'apps/web/src/components/timeline/timeline-model.ts',
        delta: '+12 -3',
        source: 'mock'
      },
      {
        kind: 'diagnostic',
        id: 'diagnostic_1',
        severity: 'warning',
        message: 'stream resumed',
        content:
          '{"type":"diagnostic","code":"warn_1","severity":"warning","message":"stream resumed","details":{"source":"sse"}}',
        source: 'runtime'
      },
      {
        kind: 'diagnostic',
        id: 'error_1',
        severity: 'error',
        message: 'runtime failed',
        content: '{"type":"error","code":"runtime_error","message":"runtime failed","details":{"exitCode":1}}',
        source: 'runtime'
      },
      {
        kind: 'run_status',
        id: 'status_1',
        label: 'running',
        content: '{"type":"status","label":"running","threadId":"thread_1","codexThreadId":"codex_thread_1"}',
        source: 'runtime'
      },
      {
        kind: 'done',
        id: 'done_1',
        runId: 'run_1',
        status: 'succeeded',
        terminationReason: 'completed',
        content: '{"type":"done","status":"succeeded","terminationReason":"completed"}',
        source: 'runtime'
      }
    ];

    const { container } = render(<Timeline items={items} />);

    expect(screen.getByText('please inspect the run')).toBeInTheDocument();
    expect(screen.getByText('I am checking the logs')).toBeInTheDocument();
    expect(screen.queryByText('Clawee')).not.toBeInTheDocument();
    expect(container.querySelector('.timeline-user_message .timeline-item-header')).not.toBeInTheDocument();
    expect(container.querySelector('.timeline-assistant_message .timeline-item-header')).not.toBeInTheDocument();
    expect(container.querySelector('.timeline-assistant_message .timeline-avatar-logo')).not.toBeInTheDocument();
    expect(screen.queryByText('Codex')).not.toBeInTheDocument();
    expect(screen.queryByText('Mock Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('{"type":"user_message","text":"please inspect the run"}')).not.toBeInTheDocument();
    expect(screen.queryByText('{"type":"assistant_message","text":"I am checking the logs"}')).not.toBeInTheDocument();
    const processDetails = container.querySelector('.timeline-process details');
    const processSummary = processDetails?.querySelector('summary');
    expect(processSummary).toHaveTextContent('已完成');
    expect(processDetails).not.toHaveAttribute('open');
    expect(screen.queryByText('运行 running')).not.toBeInTheDocument();
    expect(screen.queryByText('running')).not.toBeInTheDocument();
    expect(screen.queryByText('queued')).not.toBeInTheDocument();
    expect(screen.queryByText('排队中')).not.toBeInTheDocument();
    expect(screen.queryByText('处理中')).not.toBeInTheDocument();
    expect(screen.queryByText('我会先确认日志里有没有失败信息。')).not.toBeInTheDocument();

    await user.click(processSummary!);

    expect(screen.getByText('我会先确认日志里有没有失败信息。')).toBeInTheDocument();
    expect(screen.getByText('然后根据结果给出结论。')).toBeInTheDocument();
    expect(screen.queryByText('正在运行测试')).not.toBeInTheDocument();
    expect(screen.getByText('pnpm test')).toHaveClass('process-step-detail');
    expect(
      screen.queryByText('{"type":"tool_use","toolCallId":"call_1","name":"exec_command","input":{"command":"pnpm test"}}')
    ).not.toBeInTheDocument();
    expect(container.querySelector('.process-tool-group > summary')).toHaveTextContent('已运行测试');
    expect(screen.queryByText('工具完成 call_1')).not.toBeInTheDocument();
    expect(
      screen.queryByText('{"type":"tool_result","toolCallId":"call_1","output":"test output","exitCode":0,"isError":false}')
    ).not.toBeInTheDocument();
    expect(screen.getByText('Edited timeline model')).toBeInTheDocument();
    expect(screen.getByText('apps/web/src/components/timeline/timeline-model.ts')).toBeInTheDocument();
    expect(screen.getByText('+12 -3')).toBeInTheDocument();
    expect(screen.getByText('warning')).toBeInTheDocument();
    expect(screen.getByText('stream resumed')).toBeInTheDocument();
    expect(screen.queryByText(/"code": "warn_1"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"source": "sse"/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        '{"type":"diagnostic","code":"warn_1","severity":"warning","message":"stream resumed","details":{"source":"sse"}}'
      )
    ).not.toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('runtime failed')).toBeInTheDocument();
    expect(screen.queryByText(/"code": "runtime_error"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"exitCode": 1/)).not.toBeInTheDocument();
    expect(
      screen.queryByText('{"type":"error","code":"runtime_error","message":"runtime failed","details":{"exitCode":1}}')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('{"type":"status","label":"running","threadId":"thread_1","codexThreadId":"codex_thread_1"}')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('完成')).not.toBeInTheDocument();
    expect(screen.queryByText('{"type":"done","status":"succeeded","terminationReason":"completed"}')).not.toBeInTheDocument();
  });

  it('renders a thinking indicator for status-only active runs', () => {
    const { container } = render(
      <Timeline
        items={[
          {
            kind: 'run_status',
            id: 'status_running',
            runId: 'run_1',
            label: 'running',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(container.querySelector('.timeline-process')).toBeInTheDocument();
    expect(screen.getByText('正在思考')).toBeInTheDocument();
    expect(screen.queryByText(/等待 Clawee 返回过程/)).not.toBeInTheDocument();
    expect(screen.queryByText(/当前动态/)).not.toBeInTheDocument();
    expect(screen.queryByText('运行详情')).not.toBeInTheDocument();
    expect(container.querySelector('.process-detail')).not.toBeInTheDocument();
    expect(screen.queryByText('处理中')).not.toBeInTheDocument();
  });

  it('keeps a run process below its user message when the status arrives first', () => {
    const { container } = render(<Timeline items={[
      { kind: 'run_status', id: 'running_1', runId: 'run_1', label: 'running', source: 'runtime' },
      { kind: 'user_message', id: 'user_1', runId: 'run_1', text: '看看这个文件内容，分析下', source: 'runtime' }
    ]} />);

    const visibleItems = [...container.querySelectorAll('.timeline-item')];
    expect(visibleItems).toHaveLength(2);
    expect(visibleItems[0]).toHaveClass('timeline-user_message');
    expect(visibleItems[1]).toHaveClass('timeline-process');
    expect(visibleItems[1]).toHaveTextContent('正在思考');
  });

  it('hides internal skill context budget warnings from the user timeline', () => {
    const { container } = render(
      <Timeline
        items={[
          {
            kind: 'run_status',
            id: 'status_budget_warning',
            runId: 'run_budget_warning',
            label: 'running',
            source: 'runtime'
          },
          {
            kind: 'diagnostic',
            id: 'diagnostic_budget_warning',
            runId: 'run_budget_warning',
            severity: 'warning',
            message: 'Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill.',
            content: 'Skill descriptions were shortened to fit the 2% skills context budget.',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByText('正在思考')).toBeInTheDocument();
    expect(screen.queryByText('warning')).not.toBeInTheDocument();
    expect(screen.queryByText(/Skill descriptions were shortened/)).not.toBeInTheDocument();
    expect(container.querySelector('.process-step-diagnostic')).not.toBeInTheDocument();
  });

  it('shows the parallel-session capacity wait message', () => {
    render(
      <Timeline
        items={[
          {
            kind: 'run_status',
            id: 'status_capacity_wait',
            runId: 'run_capacity_wait',
            label: 'queued',
            source: 'runtime'
          },
          {
            kind: 'diagnostic',
            id: 'diagnostic_capacity_wait',
            runId: 'run_capacity_wait',
            severity: 'warning',
            message: '并行会话已达 10 个上限，当前任务正在等待可用执行位置',
            content: JSON.stringify({
              type: 'diagnostic',
              code: 'RUN_CONCURRENCY_LIMIT',
              severity: 'warning',
              message: '并行会话已达 10 个上限，当前任务正在等待可用执行位置'
            }),
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByText('并行会话已达 10 个上限，当前任务正在等待可用执行位置'))
      .toBeInTheDocument();
  });

  it('switches long-running work to a live elapsed label and freezes it on completion', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-30T10:00:00.000Z');
    const runningItem: TimelineItem = {
      kind: 'run_status',
      id: 'status_elapsed',
      runId: 'run_elapsed',
      timestamp: '2026-07-30T10:00:00.000Z',
      label: 'running',
      source: 'runtime'
    };
    const { container, rerender } = render(<Timeline items={[runningItem]} />);

    expect(screen.getByText('正在思考')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(11_000));

    expect(screen.getByText('已处理 11秒')).toBeInTheDocument();
    expect(container.querySelector('.process-summary-spinner')).not.toBeInTheDocument();

    rerender(
      <Timeline
        items={[
          runningItem,
          {
            kind: 'done',
            id: 'done_elapsed',
            runId: 'run_elapsed',
            timestamp: '2026-07-30T10:00:11.000Z',
            status: 'succeeded',
            content: '{"type":"done","status":"succeeded"}',
            source: 'runtime'
          }
        ]}
      />
    );

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText('已处理 11秒')).toBeInTheDocument();
    expect(container.querySelector('.timeline-process')).toHaveClass('is-complete');
    expect(container.querySelector('.process-summary-chevron')).toBeInTheDocument();
  });

  it('新运行开始不能推断上一轮成功', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-30T10:00:30.000Z');
    const items: TimelineItem[] = [
      { kind: 'run_status', id: 'old_start', runId: 'old', label: 'running', timestamp: '2026-07-30T10:00:00.000Z', source: 'runtime' },
      { kind: 'assistant_message', id: 'old_reply', runId: 'old', text: '上一轮答复', timestamp: '2026-07-30T10:00:08.000Z', source: 'runtime' },
      { kind: 'user_message', id: 'new_input', runId: 'new', text: '下一轮', timestamp: '2026-07-30T10:00:10.000Z', source: 'runtime' },
      { kind: 'run_status', id: 'new_queue', runId: 'new', label: 'queued', timestamp: '2026-07-30T10:00:10.000Z', source: 'runtime' }
    ];
    const { container, rerender } = render(<Timeline items={items} />);
    expect(container.querySelector('.timeline-process')).not.toHaveClass('is-complete');

    rerender(<Timeline items={[...items,
      { kind: 'run_status', id: 'new_start', runId: 'new', label: 'running', timestamp: '2026-07-30T10:00:12.000Z', source: 'runtime' }
    ]} />);
    expect(container.querySelectorAll('.timeline-process')).toHaveLength(2);
    expect(container.querySelector('.timeline-process')).not.toHaveClass('is-complete');
    expect(screen.getByText('上一轮答复')).toBeVisible();
    act(() => vi.advanceTimersByTime(60_000));
    expect(container.querySelector('.timeline-process')).not.toHaveClass('is-complete');
  });

  it('uses reconciled terminal run status to stop timing and keeps the summary above the final reply', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-30T10:04:00.000Z');
    const { container } = render(
      <Timeline
        items={[
          {
            kind: 'user_message',
            id: 'user_terminal',
            runId: 'run_terminal',
            runStatus: 'succeeded',
            timestamp: '2026-07-30T10:00:00.000Z',
            text: '现在几点',
            source: 'runtime'
          },
          {
            kind: 'assistant_message',
            id: 'assistant_terminal',
            runId: 'run_terminal',
            timestamp: '2026-07-30T10:03:52.000Z',
            text: '现在是 2026年7月30日 15:13:37（北京时间）。',
            source: 'runtime'
          },
          {
            kind: 'tool_step',
            id: 'tool_terminal',
            runId: 'run_terminal',
            timestamp: '2026-07-30T10:00:01.000Z',
            name: 'exec_command',
            content: '{"type":"tool_use","toolCallId":"time","name":"exec_command","input":{"command":"date"}}',
            source: 'runtime'
          },
          {
            kind: 'tool_step',
            id: 'tool_terminal_result',
            runId: 'run_terminal',
            timestamp: '2026-07-30T10:03:52.000Z',
            name: 'exec_command',
            content: '{"type":"tool_result","toolCallId":"time","output":"done"}',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByText('已处理 3分51秒')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText('已处理 3分51秒')).toBeInTheDocument();

    const process = container.querySelector('.timeline-process');
    const reply = container.querySelector('.timeline-assistant_message');
    expect(process).not.toBeNull();
    expect(reply).not.toBeNull();
    expect(process!.compareDocumentPosition(reply!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('renders local request errors outside the thinking process', () => {
    const items: TimelineItem[] = [
      {
        kind: 'user_message',
        id: 'user_1',
        text: 'hello',
        source: 'runtime'
      },
      {
        kind: 'diagnostic',
        id: 'runtime_error_1',
        severity: 'error',
        message: 'Failed to fetch',
        content: 'Failed to fetch',
        source: 'runtime'
      }
    ];

    const { container } = render(<Timeline items={items} />);

    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument();
    expect(screen.queryByText('正在思考')).not.toBeInTheDocument();
    expect(container.querySelector('.timeline-process')).not.toBeInTheDocument();
    expect(container.querySelector('.timeline-diagnostic')).toBeInTheDocument();
  });

  it('renders final assistant markdown without exposing syntax', () => {
    render(
      <Timeline
        items={[
          { kind: 'assistant_message', id: 'a1', text: '今天是 **29°C**。\n\n- 多喝水', source: 'runtime' }
        ]}
      />
    );

    expect(screen.getByText('29°C')).toHaveProperty('tagName', 'STRONG');
    expect(screen.getByText('多喝水')).toBeInTheDocument();
    expect(screen.queryByText('今天是 **29°C**。')).not.toBeInTheDocument();
  });

  it('未确认文件存在且可读时，不将回复中提到的路径显示为成果卡片', () => {
    render(<Timeline items={[{
      kind: 'assistant_message', id: 'suggested-file', source: 'runtime',
      text: '如需要，我可以把整理内容保存为：`/Users/test/Documents/Clawee/Default Project/awesome-LLM-resources-summary.md`'
    }]} onOpenFile={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '打开成果 awesome-LLM-resources-summary.md' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('任务成果')).not.toBeInTheDocument();
  });

  it('opens generated workspace files linked from assistant text', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();

    render(
      <Timeline
        items={[
          {
            kind: 'assistant_message',
            id: 'a1',
            text: '已重新生成并写入 放假.md，也生成了 `docs/report.pdf`。',
            source: 'runtime'
          }
        ]}
        onOpenFile={onOpenFile}
        canOpenFile={() => true}
      />
    );

    await user.click(screen.getByRole('link', { name: '放假.md' }));
    await user.click(screen.getByRole('link', { name: 'docs/report.pdf' }));
    await user.click(screen.getByRole('button', { name: '打开成果 report.pdf' }));

    expect(onOpenFile).toHaveBeenNthCalledWith(1, '放假.md');
    expect(onOpenFile).toHaveBeenNthCalledWith(2, 'docs/report.pdf');
    expect(onOpenFile).toHaveBeenNthCalledWith(3, 'docs/report.pdf');
    expect(screen.getByText('PDF 文档')).toBeInTheDocument();
    expect(screen.getByLabelText('任务成果')).toBeInTheDocument();
  });

  it('renders a single PDF artifact for a markdown link and opens its target path', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    render(
      <Timeline
        items={[{
          kind: 'assistant_message',
          id: 'a1',
          text: '| 文件 | 类型 |\n|---|---|\n| [`clawee-user-guide.pdf`](/workspace/output/pdf/clawee-user-guide.pdf:1) | PDF |',
          source: 'runtime'
        }]}
        onOpenFile={onOpenFile}
        canOpenFile={() => true}
      />
    );

    expect(screen.getAllByText('PDF 文档')).toHaveLength(1);
    await user.click(screen.getByRole('button', {
      name: '打开成果 clawee-user-guide.pdf'
    }));
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith('/workspace/output/pdf/clawee-user-guide.pdf');
  });

  it('shows one artifact for a repeated filename and Windows full path', async () => {
    const path = String.raw`C:\Users\example\Documents\Clawee\Default Project\AI-Agent-内容整理.md`;
    const onOpenFile = vi.fn();
    const { container } = render(<Timeline items={[{
      kind: 'assistant_message', id: 'windows-file', source: 'runtime',
      text: `文件：\`AI-Agent-内容整理.md\`\n\n位置：\`${path}\``
    }]} onOpenFile={onOpenFile} canOpenFile={() => true} />);

    expect(screen.getAllByRole('button', { name: '打开成果 AI-Agent-内容整理.md' })).toHaveLength(1);
    expect(container.querySelectorAll('.timeline-artifact-card')).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole('link', { name: path }));
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(path);
  });

  it('does not show file cards for paths the workspace cannot open', () => {
    const outside = String.raw`C:\Users\example\Documents\Clawee\Default Project\summary.md`;
    const { container } = render(<Timeline items={[
      { kind: 'change_card', id: 'outside-change', runId: 'run-1', source: 'runtime', title: 'Outside file', path: outside, delta: '1 change' },
      { kind: 'assistant_message', id: 'outside-message', source: 'runtime', text: `File: \`${outside}\` and \`reports/valid.md\`` }
    ]} onOpenFile={vi.fn()} canOpenFile={path => path === 'reports/valid.md'} />);

    expect(container.querySelector('.timeline-change_card')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开成果 summary.md' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开成果 valid.md' })).toBeInTheDocument();
  });

  it('previews a generated workspace image and opens its file', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const onPreviewImage = vi.fn(async () => 'blob:generated-image');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const view = render(
      <Timeline
        items={[{
          kind: 'assistant_message',
          id: 'generated_image',
          text: '![杨泗港大桥](outputs/bridge.png)',
          source: 'runtime'
        }]}
        onOpenFile={onOpenFile}
        canOpenFile={() => true}
        onPreviewImage={onPreviewImage}
      />
    );

    expect(await screen.findByRole('img', { name: 'bridge.png' })).toHaveAttribute('src', 'blob:generated-image');
    await user.click(screen.getByRole('button', { name: '打开成果 bridge.png' }));
    expect(onOpenFile).toHaveBeenCalledWith('outputs/bridge.png');
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:generated-image');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  describe.each(['pdf', 'png'])('%s 成果文件名', extension => {
    it.each([
      ['%E6%81%B6%E6%84%8F%E8%BD%AF%E4%BB%B6', '恶意软件'],
      ['report%20draft', 'report draft'],
      ['%23%3F%26%2B%25', '#?&+%'],
      ['literal+plus', 'literal+plus'],
      ['%2520', '%20'],
      ['原始 中文', '原始 中文'],
      ['100%', '100%'],
      ['%E6%81', '%E6%81'],
      ['%ZZ', '%ZZ'],
      ['%E6%81%B6%', '%E6%81%B6%']
    ])('安全解码 %s，展示一致且保留打开和预览路径', async (encodedName, displayName) => {
      const user = userEvent.setup();
      const path = `outputs/${encodedName}.${extension}`;
      const fileName = `${displayName}.${extension}`;
      const onOpenFile = vi.fn();
      const onPreviewImage = vi.fn(async () => 'blob:artifact');
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
      const view = render(
        <Timeline
          items={[{
            kind: 'assistant_message',
            id: 'encoded_artifact',
            text: `[成果](${path})`,
            source: 'runtime'
          }]}
          onOpenFile={onOpenFile}
          canOpenFile={() => true}
          onPreviewImage={onPreviewImage}
        />
      );

      try {
        const card = screen.getByRole('button', { name: `打开成果 ${fileName}` });
        expect(card).toHaveAttribute('title', fileName);
        expect(card.querySelector('strong')).toHaveTextContent(fileName);
        if (extension === 'png') {
          expect(await screen.findByRole('img', { name: fileName })).toHaveAttribute('src', 'blob:artifact');
          expect(onPreviewImage).toHaveBeenCalledExactlyOnceWith(path);
        } else {
          expect(onPreviewImage).not.toHaveBeenCalled();
        }
        await user.click(card);
        expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(path);
      } finally {
        view.unmount();
        Reflect.deleteProperty(URL, 'revokeObjectURL');
      }
    });
  });

  it('keeps user messages conservative while still rendering code and safe links', () => {
    render(
      <Timeline
        items={[
          {
            kind: 'user_message',
            id: 'u1',
            text: '# 不要变标题\n1. 不要变列表\n`保留代码` [链接](https://example.com)',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText('# 不要变标题')).toBeInTheDocument();
    expect(screen.getByText('保留代码')).toHaveProperty('tagName', 'CODE');
    expect(screen.getByRole('link', { name: '链接' })).toHaveAttribute('href', 'https://example.com');
  });

  it('renders markdown inside process assistant messages', () => {
    render(
      <Timeline
        items={[
          { kind: 'run_status', id: 's1', runId: 'run_1', label: 'running', source: 'runtime' },
          { kind: 'assistant_message', id: 'a1', runId: 'run_1', text: '正在检查 **日志**', source: 'runtime' }
        ]}
      />
    );

    expect(screen.getByText('日志')).toHaveProperty('tagName', 'STRONG');
  });

  it('keeps an active process with visible reasoning expanded until completion', () => {
    const { container } = render(
      <Timeline
        items={[
          {
            kind: 'run_status',
            id: 'status_running',
            runId: 'run_1',
            label: 'running',
            source: 'runtime'
          },
          {
            kind: 'reasoning_summary',
            id: 'reasoning_1',
            runId: 'run_1',
            text: '我会读取上下文再执行任务。',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByText('正在思考')).toBeInTheDocument();
    expect(screen.getByText('我会读取上下文再执行任务。')).toBeInTheDocument();
    expect(container.querySelector('.timeline-process details')).toHaveAttribute('open');
    expect(container.querySelector('.process-caret')).not.toBeInTheDocument();
    expect(screen.queryByText('处理中')).not.toBeInTheDocument();
  });

  it('keeps only the duration in the header and shows the running command on one live line', () => {
    const use = (id: string, command: string): TimelineItem => ({
      kind: 'tool_step', id: `${id}_use`, runId: 'run_summary', name: 'exec_command',
      content: JSON.stringify({ type: 'tool_use', toolCallId: id, name: 'exec_command', input: { command } }), source: 'runtime'
    });
    const result = (id: string): TimelineItem => ({
      kind: 'tool_step', id: `${id}_result`, runId: 'run_summary', name: id,
      content: JSON.stringify({ type: 'tool_result', toolCallId: id, output: '', exitCode: 0, isError: false }), source: 'runtime'
    });
    const running = [
      { kind: 'run_status', id: 'status_summary', runId: 'run_summary', label: 'running', source: 'runtime' } as TimelineItem,
      use('a', 'ls'), result('a'), use('b', 'pnpm test')
    ];
    const { container, rerender } = render(<Timeline items={running} />);

    expect(container.querySelector('.process-detail.is-active')).toBeNull();
    expect(container.querySelector('.process-summary-count')).toBeNull();
    expect(screen.getByText('正在运行 pnpm test').closest('.process-step')).toHaveClass('is-live-activity');
    expect(container.querySelectorAll('.process-step.is-live-activity')).toHaveLength(1);

    rerender(<Timeline items={[...running, result('b'), {
      kind: 'done', id: 'done_summary', runId: 'run_summary', status: 'succeeded',
      content: '{"type":"done","status":"succeeded"}', source: 'runtime'
    }]} />);
    expect(container.querySelector('.process-step.is-live-activity')).toBeNull();
  });

  it('keeps a user-collapsed active process closed after virtual remounts', async () => {
    const user = userEvent.setup();
    const activeItems: TimelineItem[] = [
      {
        kind: 'run_status',
        id: 'status_running',
        runId: 'run_persistent',
        label: 'running',
        source: 'runtime'
      },
      {
        kind: 'reasoning_summary',
        id: 'reasoning_persistent',
        runId: 'run_persistent',
        text: '正在检查项目文件。',
        source: 'runtime'
      }
    ];
    const fillerItems: TimelineItem[] = Array.from({ length: 31 }, (_, index) => ({
      kind: 'user_message',
      id: `filler_${index}`,
      text: `占位消息 ${index}`,
      source: 'runtime'
    }));
    const { container, rerender } = render(<Timeline items={activeItems} />);

    await user.click(screen.getByText('正在思考'));
    expect(container.querySelector('.timeline-process details')).not.toHaveAttribute('open');

    rerender(<Timeline items={[...activeItems, ...fillerItems]} />);
    expect(container.querySelector('.timeline-process')).not.toBeInTheDocument();

    rerender(<Timeline items={activeItems} />);
    expect(container.querySelector('.timeline-process details')).not.toHaveAttribute('open');
  });

  it('keeps a completed status-only run process available for inspection', async () => {
    const user = userEvent.setup();
    const items: TimelineItem[] = [
      {
        kind: 'user_message',
        id: 'user_1',
        text: '只回复 OK',
        content: '{"type":"user_message","text":"只回复 OK"}',
        source: 'runtime'
      },
      {
        kind: 'run_status',
        id: 'status_queued',
        runId: 'run_1',
        label: 'queued',
        source: 'runtime'
      },
      {
        kind: 'run_status',
        id: 'status_running',
        runId: 'run_1',
        label: 'running',
        source: 'runtime'
      },
      {
        kind: 'assistant_message',
        id: 'assistant_1',
        runId: 'run_1',
        text: 'OK',
        content: '{"type":"assistant_message","text":"OK"}',
        source: 'runtime'
      },
      {
        kind: 'run_status',
        id: 'status_finalizing',
        runId: 'run_1',
        label: 'finalizing',
        source: 'runtime'
      },
      {
        kind: 'done',
        id: 'done_1',
        runId: 'run_1',
        status: 'succeeded',
        terminationReason: 'completed',
        content: '{"type":"done","status":"succeeded","terminationReason":"completed"}',
        source: 'runtime'
      }
    ];

    const { container } = render(<Timeline items={items} />);

    expect(screen.getByText('只回复 OK')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(container.querySelector('.timeline-process')).toBeInTheDocument();
    expect(container.querySelector('.timeline-process details')).not.toHaveAttribute('open');
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.queryByText('正在思考')).not.toBeInTheDocument();
    await user.click(screen.getByText('已完成'));

    expect(screen.queryByText('运行详情')).not.toBeInTheDocument();
    expect(screen.queryByText('本次没有可展示的中间过程。')).not.toBeInTheDocument();
    expect(container.querySelector('.process-detail')).not.toBeInTheDocument();
    expect(screen.queryByText('queued')).not.toBeInTheDocument();
    expect(screen.queryByText('running')).not.toBeInTheDocument();
    expect(screen.queryByText('finalizing')).not.toBeInTheDocument();
  });

  it('renders failed status-only runs as visible process errors', () => {
    const items: TimelineItem[] = [
      {
        kind: 'run_status',
        id: 'status_running',
        runId: 'run_1',
        label: 'running',
        source: 'runtime'
      },
      {
        kind: 'done',
        id: 'done_failed',
        runId: 'run_1',
        status: 'failed',
        terminationReason: 'timeout',
        content: '{"type":"done","status":"failed","terminationReason":"timeout"}',
        source: 'runtime'
      }
    ];

    const { container } = render(<Timeline items={items} />);

    expect(container.querySelector('.timeline-process')).toBeInTheDocument();
    expect(container.querySelector('.timeline-process details')).toHaveAttribute('open');
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('任务运行时间过长，已自动停止')).toBeInTheDocument();
    expect(screen.queryByText('运行详情')).not.toBeInTheDocument();
  });

  it('renders readable timeout failure labels', () => {
    const reasons = [
      ['timeout', '任务运行时间过长，已自动停止'],
      ['inactivity_timeout', '任务长时间无响应，已自动停止'],
      ['spawn_timeout', 'Codex 启动超时']
    ] as const;

    for (const [terminationReason, label] of reasons) {
      const { unmount } = render(
        <Timeline
          items={[
            {
              kind: 'done',
              id: `done_${terminationReason}`,
              runId: `run_${terminationReason}`,
              status: 'failed',
              terminationReason,
              content: JSON.stringify({ type: 'done', status: 'failed', terminationReason }),
              source: 'runtime'
            }
          ]}
        />
      );

      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it('keeps the original failure reason visible in an expandable process', async () => {
    const { container } = render(
      <Timeline
        items={[
          {
            kind: 'diagnostic',
            id: 'diagnostic_timeout',
            runId: 'run_timeout',
            severity: 'error',
            message: 'Codex app-server inactivity timeout after 600000ms',
            content: '{"type":"diagnostic","severity":"error"}',
            source: 'runtime'
          },
          {
            kind: 'done',
            id: 'done_timeout',
            runId: 'run_timeout',
            status: 'failed',
            terminationReason: 'inactivity_timeout',
            content: '{"type":"done","status":"failed","terminationReason":"inactivity_timeout"}',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByText('Codex app-server inactivity timeout after 600000ms')).toBeInTheDocument();
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
    expect(screen.queryByText(/terminationReason/u)).not.toBeInTheDocument();
    expect(container.querySelectorAll('.process-step')).toHaveLength(1);
    await userEvent.setup().click(container.querySelector('.timeline-process summary')!);
    expect(screen.queryByText('Codex app-server inactivity timeout after 600000ms')).not.toBeInTheDocument();
  });

  it('shows an active writer error instead of a generic stream error', () => {
    render(<Timeline items={[
      { kind: 'diagnostic', id: 'writer-error', runId: 'run-writer', severity: 'error',
        message: 'thread already has an active writer', content: '{}', source: 'runtime' },
      { kind: 'done', id: 'writer-done', runId: 'run-writer', status: 'failed',
        terminationReason: 'stream_error', content: '{}', source: 'runtime' }
    ]} />);
    expect(screen.getByText('thread already has an active writer')).toBeInTheDocument();
    expect(screen.queryByText('Codex 输出异常')).not.toBeInTheDocument();
  });

  it('redacts credentials in historical error details', () => {
    render(<Timeline items={[
      { kind: 'diagnostic', id: 'credential-error', runId: 'run-secret', severity: 'error',
        message: 'request failed: Bearer sk-not-for-display', content: '{}', source: 'runtime' },
      { kind: 'done', id: 'credential-done', runId: 'run-secret', status: 'failed',
        terminationReason: 'stream_error', content: '{}', source: 'runtime' }
    ]} />);
    expect(screen.getByText('request failed: Bearer [REDACTED]')).toBeInTheDocument();
    expect(screen.queryByText(/sk-not-for-display/)).not.toBeInTheDocument();
  });

  it('does not show opaque toolCallId in the main title when tool_use is missing', () => {
    render(
      <Timeline
        items={[
          {
            kind: 'tool_step',
            id: 'tool_result_only',
            runId: 'run_1',
            name: 'call_missing',
            content: '{"type":"tool_result","toolCallId":"call_missing","output":"done","isError":false}',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.queryByText('操作已完成')).not.toBeInTheDocument();
    expect(screen.queryByText('工具完成 call_missing')).not.toBeInTheDocument();
  });

  it('renders a plain Chinese activity with its command but without tool JSON', () => {
    const content =
      '{"type":"tool_use","toolCallId":"call_1","name":"exec_command","input":{"cmd":"pnpm --filter @clawee/web test -- src/app/App.test.tsx"}}';

    render(
      <Timeline
        items={[
          {
            kind: 'tool_step',
            id: 'tool_use_1',
            runId: 'run_1',
            name: 'exec_command',
            content,
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByText('正在运行 pnpm --filter @clawee/web test -- src/app/App.test.tsx')).toHaveClass('process-live-text');
    expect(screen.queryByText(content)).not.toBeInTheDocument();
  });

  it('keeps the previous tool step when the next tool starts', () => {
    const firstTool: TimelineItem = {
      kind: 'tool_step',
      id: 'tool_read',
      runId: 'run_1',
      name: 'exec_command',
      content: '{"type":"tool_use","toolCallId":"call_read","name":"exec_command","input":{"command":"pwd"}}',
      source: 'runtime'
    };
    const nextTool: TimelineItem = {
      kind: 'tool_step',
      id: 'tool_test',
      runId: 'run_1',
      name: 'exec_command',
      content: '{"type":"tool_use","toolCallId":"call_test","name":"exec_command","input":{"command":"pnpm test"}}',
      source: 'runtime'
    };
    const { container, rerender } = render(<Timeline items={[firstTool]} />);

    expect(screen.getByText('正在运行 pwd')).toBeInTheDocument();

    rerender(<Timeline items={[firstTool, nextTool]} />);

    expect(screen.queryByText('正在运行 pwd')).not.toBeInTheDocument();
    expect(screen.getByText('正在运行 pnpm test')).toBeInTheDocument();
    expect(container.querySelectorAll('.process-tool-call')).toHaveLength(1);
  });

  it('keeps every completed tool call as its own step during a run', () => {
    const items: TimelineItem[] = Array.from({ length: 3 }, (_, index) => [
      {
        kind: 'tool_step' as const,
        id: `tool_use_${index}`,
        runId: 'run_1',
        name: 'exec_command',
        content: JSON.stringify({
          type: 'tool_use',
          toolCallId: `call_${index}`,
          name: 'exec_command',
          input: { command: `echo ${index}` }
        }),
        source: 'runtime' as const
      },
      {
        kind: 'tool_step' as const,
        id: `tool_result_${index}`,
        runId: 'run_1',
        name: `call_${index}`,
        content: JSON.stringify({
          type: 'tool_result',
          toolCallId: `call_${index}`,
          output: String(index),
          exitCode: 0,
          isError: false
        }),
        source: 'runtime' as const
      }
    ]).flat();

    const { container } = render(<Timeline items={items} />);

    expect(container.querySelector('.process-tool-group > summary')).toHaveTextContent(/^已运行 echo$/u);
    expect(container.querySelectorAll('.process-tool-call')).toHaveLength(3);
    expect(['echo 0', 'echo 1', 'echo 2'].map(command => screen.getByText(command))).toHaveLength(3);
  });

  it('merges an approved command into its completed local command step', () => {
    const items: TimelineItem[] = [
      {
        kind: 'tool_step',
        id: 'command_use',
        runId: 'run_approved_command',
        name: 'exec_command',
        content: JSON.stringify({
          type: 'tool_use',
          toolCallId: 'command_call',
          name: 'exec_command',
          input: { command: 'open https://example.com' }
        }),
        source: 'runtime'
      },
      {
        kind: 'tool_step',
        id: 'command_result',
        runId: 'run_approved_command',
        name: 'command_call',
        content: JSON.stringify({
          type: 'tool_result',
          toolCallId: 'command_call',
          output: '',
          exitCode: 0,
          isError: false
        }),
        source: 'runtime'
      },
      {
        kind: 'approval',
        id: 'approval_resolved',
        runId: 'run_approved_command',
        approval: {
          id: 'approval_command',
          runId: 'run_approved_command',
          threadId: 'thread_approved_command',
          turnId: 'turn_approved_command',
          itemId: 'item_approved_command',
          requestId: 'request_approved_command',
          kind: 'command_execution',
          status: 'approved',
          risk: 'high',
          title: '允许执行命令',
          summary: '打开网页',
          details: { command: 'open https://example.com' },
          requestedAt: '2026-07-30T08:00:00.000Z',
          expiresAt: '2026-07-30T08:10:00.000Z',
          resolvedAt: '2026-07-30T08:01:00.000Z'
        },
        source: 'runtime'
      }
    ];

    render(<Timeline items={items} />);

    expect(screen.getByText('已允许并打开 example.com')).toBeInTheDocument();
    expect(screen.queryByText('已允许执行命令')).not.toBeInTheDocument();
    expect(screen.queryByText('已执行本地命令')).not.toBeInTheDocument();
  });

  it('names unlabeled tools with a fallback and shows edited file paths', () => {
    const use = (id: string, name: string, input: unknown): TimelineItem => ({
      kind: 'tool_step', id: `${id}_use`, runId: 'run_fallback', name,
      content: JSON.stringify({ type: 'tool_use', toolCallId: id, name, input }), source: 'runtime'
    });
    const result = (id: string): TimelineItem => ({
      kind: 'tool_step', id: `${id}_result`, runId: 'run_fallback', name: id,
      content: JSON.stringify({ type: 'tool_result', toolCallId: id, output: '', exitCode: 0, isError: false }), source: 'runtime'
    });
    const { container } = render(
      <Timeline
        items={[
          use('custom', 'mcp__crm__lookup', { customer_id: 'c-1' }), result('custom'),
          use('patch', 'apply_patch', '*** Begin Patch\n*** Update File: src/app.ts\n*** Add File: src/new.ts\n*** End Patch'), result('patch'),
          use('cmd', 'exec_command', { command: 'node scripts/sync.mjs' }), result('cmd'),
          use('mcp', 'docs__search', { arguments: { query: 'virtuoso threshold' } }), result('mcp')
        ]}
      />
    );

    expect(screen.getByText('已执行开发操作')).toBeInTheDocument();
    expect(screen.getByText('已更新文件')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.className === 'process-step-detail'
      && element.textContent === 'src/app.ts\nsrc/new.ts')).toBeInTheDocument();
    expect(screen.getByText('已运行 sync.mjs')).toBeInTheDocument();
    expect(screen.getByText('node scripts/sync.mjs')).toHaveClass('process-step-detail');
    expect(screen.getByText('virtuoso threshold')).toHaveClass('process-step-detail');
    expect(container.querySelectorAll('.process-tool-call')).toHaveLength(4);
    expect(container.querySelector('.process-tool-group > summary'))
      .toHaveTextContent('已执行开发操作 · 已更新文件 · 已运行 sync.mjs · 已查询资料');
  });

  it('names each local command by what it touched instead of a generic label', () => {
    const commands: Array<[string, string]> = [
      ["/bin/zsh -lc 'cat ~/.codex/skills/web-tools-guide/SKILL.md'", '已读取 Web Tools Guide 技能'],
      ['command -v opencli', '已检查 opencli'],
      ["python3 - <<'PY'\nimport urllib.request\nPY", '已运行 Python 脚本'],
      ['curl -sL https://www.cnbc.com/ai/', '已请求 cnbc.com'],
      ['rg -n "followOutput" src', '已搜索 “followOutput”'],
      ['ls -la', '已查看当前目录'],
      ['cd apps/web && cat package.json', '已读取 package.json'],
      ['node scripts/sync.mjs', '已运行 sync.mjs'],
      ['pnpm --filter @clawee/web typecheck', '已运行 pnpm typecheck'],
      ['open https://example.com', '已打开 example.com'],
      ['/bin/zsh -lc "python3 -c \\"print(1)\\""', '已运行 Python 脚本'],
      ["sed -n '1,80p' notes.md | grep -E '(a|e)'", '已读取 notes.md']
    ];
    const items: TimelineItem[] = commands.flatMap(([command], index) => [
      { kind: 'tool_step', id: `u${index}`, runId: 'run_named', name: 'exec_command',
        content: JSON.stringify({ type: 'tool_use', toolCallId: `c${index}`, name: 'exec_command', input: { command } }), source: 'runtime' },
      { kind: 'tool_step', id: `r${index}`, runId: 'run_named', name: `c${index}`,
        content: JSON.stringify({ type: 'tool_result', toolCallId: `c${index}`, output: '', exitCode: 0, isError: false }), source: 'runtime' }
    ] satisfies TimelineItem[]);
    const { container } = render(<Timeline items={items} />);

    expect([...container.querySelectorAll('.process-tool-call > .process-step-title')].map(node => node.textContent))
      .toEqual(commands.map(([, label]) => label));
    expect(container.querySelector('.process-tool-group > summary'))
      .toHaveTextContent(`${commands.slice(0, 3).map(([, label]) => label).join(' · ')} 等 ${new Set(commands.map(([, label]) => label)).size} 项`);
    expect(screen.queryByText('已执行本地命令')).not.toBeInTheDocument();
  });

  it('skips empty reasoning items so they neither add a gap nor split a tool group', () => {
    const use = (id: string, command: string): TimelineItem => ({
      kind: 'tool_step', id: `${id}_use`, runId: 'run_empty', name: 'exec_command',
      content: JSON.stringify({ type: 'tool_use', toolCallId: id, name: 'exec_command', input: { command } }), source: 'runtime'
    });
    const result = (id: string): TimelineItem => ({
      kind: 'tool_step', id: `${id}_result`, runId: 'run_empty', name: id,
      content: JSON.stringify({ type: 'tool_result', toolCallId: id, output: '', exitCode: 0, isError: false }), source: 'runtime'
    });
    const { container } = render(
      <Timeline
        items={[
          { kind: 'reasoning_summary', id: 'n1', runId: 'run_empty', text: '先补齐被截断的报道。', source: 'runtime' },
          use('a', 'node a.mjs'), result('a'),
          { kind: 'reasoning_summary', id: 'empty', runId: 'run_empty', text: '', source: 'runtime' },
          use('b', 'node b.mjs'), result('b')
        ]}
      />
    );

    expect(container.querySelectorAll('.process-step-narration')).toHaveLength(1);
    expect(container.querySelectorAll('.process-step-tools')).toHaveLength(1);
    expect(container.querySelector('.process-tool-group > summary')).toHaveTextContent('已运行 a.mjs · 已运行 b.mjs');
  });

  it('labels search, directory listing and file reads separately', () => {
    const use = (id: string, name: string, input: unknown): TimelineItem => ({
      kind: 'tool_step', id: `${id}_use`, runId: 'run_labels', name,
      content: JSON.stringify({ type: 'tool_use', toolCallId: id, name, input }), source: 'runtime'
    });
    const result = (id: string): TimelineItem => ({
      kind: 'tool_step', id: `${id}_result`, runId: 'run_labels', name: id,
      content: JSON.stringify({ type: 'tool_result', toolCallId: id, output: '', exitCode: 0, isError: false }), source: 'runtime'
    });
    const commands = ['rg -n foo src', 'git grep foo', 'ls -la', 'sed -n 1,20p a.ts'];
    render(
      <Timeline
        items={[
          ...commands.flatMap((command, index) => [use(`c${index}`, 'exec_command', { command }), result(`c${index}`)]),
          use('m', 'docs__search', { arguments: { query: 'q' } }), result('m')
        ]}
      />
    );

    expect(screen.getAllByText('已搜索 “foo”')).toHaveLength(2);
    expect(screen.getByText('已查看当前目录')).toBeInTheDocument();
    expect(screen.getByText('已读取 a.ts')).toBeInTheDocument();
    expect(screen.getByText('已查询资料')).toBeInTheDocument();
  });

  it('flags a failed command with its exit code and error output, and keeps progress notes', () => {
    const use = (id: string, command: string): TimelineItem => ({
      kind: 'tool_step', id: `${id}_use`, runId: 'run_fail', name: 'exec_command',
      content: JSON.stringify({ type: 'tool_use', toolCallId: id, name: 'exec_command', input: { command } }), source: 'runtime'
    });
    const result = (id: string, exitCode: number, output: string): TimelineItem => ({
      kind: 'tool_step', id: `${id}_result`, runId: 'run_fail', name: id,
      content: JSON.stringify({ type: 'tool_result', toolCallId: id, output, exitCode, isError: exitCode !== 0 }), source: 'runtime'
    });
    const { container } = render(
      <Timeline
        items={[
          { kind: 'reasoning_summary', id: 'note', runId: 'run_fail', text: '正在运行时间线测试', source: 'runtime' },
          use('a', 'pnpm test'), result('a', 1, 'AssertionError: expected 200 to be 900'),
          use('b', 'pnpm test'), result('b', 0, 'Tests  76 passed')
        ]}
      />
    );

    expect(screen.getByText('正在运行时间线测试').closest('.process-step')).toHaveClass('process-step-narration');
    const failed = screen.getByText('运行测试失败').closest('.process-tool-call')!;
    expect(failed).toHaveClass('is-failed');
    expect(failed.closest('details.process-tool-group')).toHaveAttribute('open');
    expect(failed).toHaveTextContent('退出码 1');
    expect(failed.querySelector('details.process-step-output')).toHaveAttribute('open');
    expect(failed).toHaveTextContent('AssertionError: expected 200 to be 900');

    const passed = screen.getByText('已运行测试', { selector: '.process-tool-call > .process-step-title' }).closest('.process-tool-call')!;
    expect(passed).not.toHaveClass('is-failed');
    expect(passed.querySelector('details.process-step-output')).not.toHaveAttribute('open');
    expect(container.querySelectorAll('.process-step-exit')).toHaveLength(1);
  });

  it.each(['live', 'history'] as const)('自动展开 %s MCP 错误并显示具体原因', source => {
    const name = 'enterprise_agent_activity__agent_detail';
    const output = '未获授权查看员工会话正文（content_forbidden）';
    const input = { arguments: { agent_id: 'agent-1', include_content: true } };
    const items = source === 'history'
      ? mapHistoryItemsToTimelineItems([
          { id: 'call:use', runId: 'run_mcp', type: 'tool_use', name, input, createdAt: '2026-10-27T10:00:00Z' },
          { id: 'call:result', runId: 'run_mcp', type: 'tool_result', name, output, isError: true, createdAt: '2026-10-27T10:00:01Z' }
        ])
      : [
          eventToTimelineItem({ id: 'call:use', runId: 'run_mcp', seq: 1, ts: '2026-10-27T10:00:00Z', normalizerVersion: 2,
            type: 'tool_use', payload: { type: 'tool_use', toolCallId: 'call', name, input } }),
          eventToTimelineItem({ id: 'call:result', runId: 'run_mcp', seq: 2, ts: '2026-10-27T10:00:01Z', normalizerVersion: 2,
            type: 'tool_result', payload: { type: 'tool_result', toolCallId: 'call', output, isError: true,
              response: { code: 'content_forbidden', message: '未获授权查看员工会话正文', retryable: false } } })
        ].filter((item): item is TimelineItem => item !== null);
    const { container } = render(<Timeline items={items} />);

    expect(screen.getByText(output)).toBeVisible();
    expect(screen.getByText('错误输出')).toBeVisible();
    expect(container.querySelector('.process-tool-group')).toHaveAttribute('open');
    expect(container.querySelector('.process-step-output')).toHaveAttribute('open');
    expect(container.querySelector('.process-tool-call')).toHaveClass('is-failed');
    expect(screen.queryByText('MCP tool call failed')).not.toBeInTheDocument();
  });

  it('shows generic commands next to business milestones', async () => {
    const user = userEvent.setup();
    const items: TimelineItem[] = [
      {
        kind: 'tool_step',
        id: 'browser_use',
        runId: 'run_1',
        name: 'browser_open',
        content: '{"type":"tool_use","toolCallId":"browser_call","name":"browser_open","input":{"url":"https://example.com"}}',
        source: 'runtime'
      },
      {
        kind: 'tool_step',
        id: 'browser_result',
        runId: 'run_1',
        name: 'browser_call',
        content: '{"type":"tool_result","toolCallId":"browser_call","output":"done","isError":false}',
        source: 'runtime'
      },
      {
        kind: 'tool_step',
        id: 'command_use',
        runId: 'run_1',
        name: 'exec_command',
        content: '{"type":"tool_use","toolCallId":"command_call","name":"exec_command","input":{"command":"echo done"}}',
        source: 'runtime'
      },
      {
        kind: 'tool_step',
        id: 'command_result',
        runId: 'run_1',
        name: 'command_call',
        content: '{"type":"tool_result","toolCallId":"command_call","output":"done","isError":false}',
        source: 'runtime'
      },
      {
        kind: 'done',
        id: 'done_1',
        runId: 'run_1',
        status: 'succeeded',
        content: '{"type":"done","status":"succeeded"}',
        source: 'runtime'
      }
    ];

    const { container } = render(<Timeline items={items} />);
    await user.click(screen.getByText('已完成'));

    expect(screen.getByText('已使用浏览器')).toBeInTheDocument();
    expect(screen.getByText('https://example.com')).toHaveClass('process-step-detail');
    expect(screen.getByText('echo done')).toHaveClass('process-step-detail');
    expect(container.querySelectorAll('.process-tool-call')).toHaveLength(2);
  });

  it('folds repeated activities into one group row and still lists every call', () => {
    const items: TimelineItem[] = Array.from({ length: 3 }, (_, index) => [
      {
        kind: 'tool_step' as const,
        id: `image_use_${index}`,
        runId: 'run_1',
        name: 'view_image',
        content: JSON.stringify({
          type: 'tool_use',
          toolCallId: `image_call_${index}`,
          name: 'view_image',
          input: { path: `/tmp/${index}.png` }
        }),
        source: 'runtime' as const
      },
      {
        kind: 'tool_step' as const,
        id: `image_result_${index}`,
        runId: 'run_1',
        name: `image_call_${index}`,
        content: JSON.stringify({
          type: 'tool_result',
          toolCallId: `image_call_${index}`,
          output: 'done',
          isError: false
        }),
        source: 'runtime' as const
      }
    ]).flat();

    const { container } = render(<Timeline items={items} />);

    expect(container.querySelector('.process-tool-group > summary')).toHaveTextContent(/^已查看图片$/u);
    expect(container.querySelectorAll('.process-tool-call')).toHaveLength(3);
    expect(screen.queryByText(/（3 次）/u)).not.toBeInTheDocument();
  });

  it('全部正文独立显示，过程收起不隐藏中间回答', async () => {
    const user = userEvent.setup();
    const items: TimelineItem[] = [
      {
        kind: 'user_message',
        id: 'user_1',
        text: '检查当前目录并总结结果',
        source: 'runtime'
      },
      {
        kind: 'run_status',
        id: 'status_running',
        runId: 'run_1',
        label: 'running',
        source: 'runtime'
      },
      {
        kind: 'assistant_message',
        id: 'assistant_process_1',
        runId: 'run_1',
        text: '我会先确认当前目录，再读取相关文件做判断。',
        source: 'runtime'
      },
      {
        kind: 'tool_step',
        id: 'tool_use_1',
        runId: 'run_1',
        name: 'command_execution',
        content: '{"type":"tool_use","toolCallId":"call_1","name":"command_execution","input":{"command":"pwd"}}',
        source: 'runtime'
      },
      {
        kind: 'tool_step',
        id: 'tool_result_1',
        runId: 'run_1',
        name: 'call_1',
        content: '{"type":"tool_result","toolCallId":"call_1","output":"/repo","exitCode":0,"isError":false}',
        source: 'runtime'
      },
      {
        kind: 'assistant_message',
        id: 'assistant_final',
        runId: 'run_1',
        text: '当前目录是 /repo，检查已完成。',
        source: 'runtime'
      },
      {
        kind: 'done',
        id: 'done_1',
        runId: 'run_1',
        status: 'succeeded',
        terminationReason: 'completed',
        content: '{"type":"done","status":"succeeded","terminationReason":"completed"}',
        source: 'runtime'
      }
    ];

    const { container } = render(<Timeline items={items} />);

    expect(screen.getByText('检查当前目录并总结结果')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('我会先确认当前目录，再读取相关文件做判断。')).toBeVisible();

    await user.click(screen.getByText('已完成'));

    expect(screen.getByText('我会先确认当前目录，再读取相关文件做判断。')).toBeInTheDocument();
    expect(screen.queryByText('正在查看项目内容')).not.toBeInTheDocument();
    expect(screen.getByText('pwd')).toHaveClass('process-step-detail');
    expect(container.querySelector('.process-tool-group > summary')).toHaveTextContent('已查看当前目录');
    expect(screen.queryByText('工具完成 call_1')).not.toBeInTheDocument();
    expect(screen.getByText('当前目录是 /repo，检查已完成。')).toBeInTheDocument();
    expect(container.querySelectorAll('.timeline-assistant_message')).toHaveLength(2);
    expect(container.querySelector('.timeline-process details')).toHaveAttribute('open');
  });

  it('shows elapsed time for completed runs with timestamped events', () => {
    render(
      <Timeline
        items={[
          {
            kind: 'run_status',
            id: 'status_timed',
            runId: 'run_timed',
            timestamp: '2026-07-24T10:00:00.000Z',
            label: 'running',
            source: 'runtime'
          },
          {
            kind: 'done',
            id: 'done_timed',
            runId: 'run_timed',
            timestamp: '2026-07-24T10:01:05.000Z',
            status: 'succeeded',
            content: '{"type":"done","status":"succeeded"}',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByText('已处理 1分5秒')).toBeInTheDocument();
  });

  it('renders reasoning summaries as the main process content', () => {
    render(
      <Timeline
        items={[
          {
            kind: 'run_status',
            id: 'status_running',
            runId: 'run_1',
            label: 'running',
            source: 'runtime'
          },
          {
            kind: 'reasoning_summary',
            id: 'reasoning_1',
            runId: 'run_1',
            text: '我先读取用户要求和工作区状态。\n\n然后调用本地工具完成任务。',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByText('我先读取用户要求和工作区状态。')).toBeInTheDocument();
    expect(screen.getByText('然后调用本地工具完成任务。')).toBeInTheDocument();
    expect(screen.queryByText('running')).not.toBeInTheDocument();
    expect(screen.queryByText('处理中')).not.toBeInTheDocument();
  });

  it('keeps strategy narration and earlier progress notes, with the latest one as the live activity', () => {
    const { rerender } = render(
      <Timeline
        items={[
          {
            kind: 'run_status',
            id: 'status_strategy',
            runId: 'run_strategy',
            label: 'running',
            source: 'runtime'
          },
          {
            kind: 'reasoning_summary',
            id: 'strategy',
            runId: 'run_strategy',
            text: '我会先确认可访问性和索引信号，再检查首页内容与技术要素。',
            source: 'runtime'
          },
          {
            kind: 'reasoning_summary',
            id: 'planning',
            runId: 'run_strategy',
            text: 'Planning skill reference review',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByText('我会先确认可访问性和索引信号，再检查首页内容与技术要素。')).toBeInTheDocument();
    expect(screen.getByText('正在确认执行方案')).toBeInTheDocument();
    expect(screen.queryByText('Planning skill reference review')).not.toBeInTheDocument();

    rerender(
      <Timeline
        items={[
          {
            kind: 'run_status',
            id: 'status_strategy',
            runId: 'run_strategy',
            label: 'running',
            source: 'runtime'
          },
          {
            kind: 'reasoning_summary',
            id: 'strategy',
            runId: 'run_strategy',
            text: '我会先确认可访问性和索引信号，再检查首页内容与技术要素。',
            source: 'runtime'
          },
          {
            kind: 'reasoning_summary',
            id: 'planning',
            runId: 'run_strategy',
            text: 'Planning skill reference review',
            source: 'runtime'
          },
          {
            kind: 'reasoning_summary',
            id: 'inspect',
            runId: 'run_strategy',
            text: 'Inspecting site with curl',
            source: 'runtime'
          }
        ]}
      />
    );

    expect(screen.getByText('正在确认执行方案').closest('.process-step')).toHaveClass('process-step-narration');
    expect(screen.getByText('正在检查网站可访问性').closest('.process-step')).toHaveClass('is-live-activity');
    expect(screen.queryByText('Inspecting site with curl')).not.toBeInTheDocument();
  });

  it('opens a file change card by path', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const items: TimelineItem[] = [
      {
        kind: 'change_card',
        id: 'change_1',
        title: 'Edited timeline model',
        path: 'apps/web/src/components/timeline/timeline-model.ts',
        delta: '+12 -3',
        source: 'mock'
      }
    ];

    render(<Timeline items={items} onOpenFile={onOpenFile} />);

    const fileButton = screen.getByRole('button', {
      name: '打开文件 apps/web/src/components/timeline/timeline-model.ts'
    });

    expect(fileButton).toHaveAttribute(
      'aria-label',
      '打开文件 apps/web/src/components/timeline/timeline-model.ts'
    );

    await user.click(fileButton);

    expect(onOpenFile).toHaveBeenCalledWith('apps/web/src/components/timeline/timeline-model.ts');
  });

  it('does not expose run detail from the process block', () => {
    const items: TimelineItem[] = [
      {
        kind: 'run_status',
        id: 'status_1',
        runId: 'run_1',
        label: 'running',
        source: 'runtime'
      },
      {
        kind: 'reasoning_summary',
        id: 'reasoning_1',
        runId: 'run_1',
        text: '我会先整理可见过程。',
        source: 'runtime'
      }
    ];

    render(<Timeline items={items} />);

    expect(screen.queryByRole('button', { name: /查看运行详情/ })).not.toBeInTheDocument();
    expect(screen.queryByText('运行详情')).not.toBeInTheDocument();
  });

  it('keeps queued follow-ups out of the conversation timeline', () => {
    render(
      <Timeline
        items={[{
          kind: 'user_message',
          id: 'queued_message',
          text: '排队任务',
          runId: 'run_queued',
          runStatus: 'queued',
          submissionMode: 'interrupt_and_enqueue',
          queuePosition: 2,
          source: 'runtime'
        }]}
      />
    );

    expect(screen.queryByText('排队任务')).not.toBeInTheDocument();
  });

  it('keeps canceled follow-ups that never ran out of the conversation timeline', () => {
    render(
      <Timeline
        items={[{
          kind: 'user_message',
          id: 'canceled_queued_message',
          text: '已移除的等待任务',
          runId: 'run_canceled_queued',
          runStatus: 'canceled',
          submissionMode: 'enqueue',
          wasQueued: true,
          source: 'runtime'
        }]}
      />
    );

    expect(screen.queryByText('已移除的等待任务')).not.toBeInTheDocument();
  });

  it('groups consecutive file changes from the same run', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const items: TimelineItem[] = [
      {
        kind: 'change_card',
        id: 'change_1',
        runId: 'run_1',
        title: '修改 App.tsx',
        path: 'apps/web/src/app/App.tsx',
        delta: '1 项变更',
        source: 'runtime'
      },
      {
        kind: 'change_card',
        id: 'change_2',
        runId: 'run_1',
        title: '修改 Timeline.tsx',
        path: 'apps/web/src/components/timeline/Timeline.tsx',
        delta: '1 项变更',
        source: 'runtime'
      },
      {
        kind: 'change_card',
        id: 'change_3',
        runId: 'run_1',
        title: '再次修改 App.tsx',
        path: 'apps/web/src/app/App.tsx',
        delta: '1 项变更',
        source: 'runtime'
      }
    ];

    render(<Timeline items={items} onOpenFile={onOpenFile} />);

    expect(screen.getByText('3 次连续文件变更')).toBeInTheDocument();
    expect(screen.getByText('2 个文件')).toBeInTheDocument();
    expect(screen.queryByText('修改 App.tsx')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', {
      name: '打开文件 apps/web/src/app/App.tsx'
    }));

    expect(onOpenFile).toHaveBeenCalledWith('apps/web/src/app/App.tsx');
  });

  it('shows a new-content action when updates arrive while viewing older history', async () => {
    const user = userEvent.setup();
    const initialItems: TimelineItem[] = [
      {
        kind: 'user_message',
        id: 'history_1',
        text: '较早的内容',
        source: 'runtime'
      }
    ];
    const { rerender } = render(<Timeline items={initialItems} />);
    const scroller = screen.getByTestId('virtuoso-scroller');
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1200 }
    });

    fireEvent.wheel(scroller, { deltaY: -100 });
    fireEvent.scroll(scroller, { target: { scrollTop: 200 } });
    rerender(
      <Timeline
        items={[
          ...initialItems,
          {
            kind: 'assistant_message',
            id: 'latest_1',
            text: '刚刚到达的新内容',
            source: 'runtime'
          }
        ]}
      />
    );

    const newContentButton = await screen.findByRole('button', { name: '有新内容' });
    await user.click(newContentButton);

    expect(screen.queryByRole('button', { name: '有新内容' })).not.toBeInTheDocument();
  });

  it('renders the Clawee empty state', () => {
    render(<Timeline items={[]} />);

    expect(screen.getByText('暂无任务记录')).toBeInTheDocument();
    expect(screen.getByText('发送任务后，Clawee 会在这里展示处理过程和结果。')).toBeInTheDocument();
  });

  it('keeps long histories virtualized and exposes older-page loading', async () => {
    const user = userEvent.setup();
    const onLoadOlder = vi.fn(async () => undefined);
    const items = Array.from({ length: 379 }, (_, index): TimelineItem => ({
      kind: 'user_message',
      id: `history_${index}`,
      text: `历史消息 ${index}`,
      source: 'runtime'
    }));

    const { container } = render(
      <Timeline
        items={items}
        hasMore
        loadingOlder={false}
        onLoadOlder={onLoadOlder}
      />
    );

    expect(container.querySelectorAll('.timeline-item').length).toBeLessThan(80);

    await user.click(screen.getByRole('button', { name: '加载更早记录' }));

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('keeps the visible item anchored when prepending history changes a process block key', () => {
    const initialItems: TimelineItem[] = [
      {
        kind: 'tool_step',
        id: 'current_process_step',
        name: 'exec_command',
        content: '{"type":"tool_use","name":"exec_command","input":{"command":"pwd"}}',
        source: 'runtime'
      },
      {
        kind: 'user_message',
        id: 'current_user_message',
        text: '当前可见消息',
        source: 'runtime'
      }
    ];
    const { rerender } = render(<Timeline items={initialItems} />);
    const currentMessage = screen.getByText('当前可见消息').closest('[data-item-index]');

    expect(currentMessage).toHaveAttribute('data-item-index', '100001');

    rerender(
      <Timeline
        items={[
          {
            kind: 'user_message',
            id: 'older_user_message',
            text: '更早的消息',
            source: 'runtime'
          },
          {
            kind: 'tool_step',
            id: 'older_process_step',
            name: 'exec_command',
            content: '{"type":"tool_use","name":"exec_command","input":{"command":"ls"}}',
            source: 'runtime'
          },
          ...initialItems
        ]}
      />
    );

    expect(screen.getByText('当前可见消息').closest('[data-item-index]'))
      .toHaveAttribute('data-item-index', '100001');
  });
});
