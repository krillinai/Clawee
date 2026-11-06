import type {
  AgentEventEnvelope,
  AttachmentResponse,
  ThreadHistoryItem
} from '@clawee/protocol';
import { describe, expect, it } from 'vitest';
import { mapCodexTurnsPage } from '../../src/codex/sessions/app-server-history-mapper.js';
import { normalizeAppServerEvent } from '../../src/events/normalizer.js';
import {
  attachRunAttachmentsToThreadHistory,
  mergeRunEventsIntoThreadHistory,
  reconcileRunPromptsInThreadHistory
} from '../../src/threads/run-event-history.js';

describe('run event thread history', () => {
  it('聚合未完成的思考摘要，完成快照替换全文并保持首次时间和最新水位', () => {
    const events = [
      event('reasoning_summary', 1, { type: 'reasoning_summary', text: '第一段', delivery: 'delta', format: 'plain_text' }, 'thinking'),
      event('reasoning_summary', 2, { type: 'reasoning_summary', text: '\n\n第二段', delivery: 'delta', format: 'plain_text' }, 'thinking')
    ];
    const source = { ...run('run-1'), status: 'running' as const };
    expect(mergeRunEventsIntoThreadHistory([], [source], () => events)).toMatchObject([
      { id: 'run-1:thinking', type: 'reasoning_summary', text: '第一段\n\n第二段', eventSeq: 2, createdAt: events[0]!.ts }
    ]);
    const completed = event('reasoning_summary', 3, {
      type: 'reasoning_summary', text: '校正后的摘要', delivery: 'summary', format: 'plain_text'
    }, 'thinking');
    expect(mergeRunEventsIntoThreadHistory([], [source], () => [...events, completed])).toMatchObject([
      { id: 'run-1:thinking', type: 'reasoning_summary', text: '校正后的摘要', eventSeq: 3, createdAt: events[0]!.ts }
    ]);
    expect(mergeRunEventsIntoThreadHistory([], [{ ...source, status: 'canceled' }], () => events))
      .toMatchObject([{ text: '第一段\n\n第二段', eventSeq: 2 }]);
  });

  it.each(['turn', 'item'] as const)('filtered payloads preserve %s ownership from non-display events', scope => {
    const identity = { runId: 'run-1', rawEventId: scope === 'item' ? 'body' : 'identity-only',
      ...(scope === 'turn' ? { turnId: 'turn-1' } : {}) };
    const history: ThreadHistoryItem[] = [{ id: 'body', type: 'assistant_message', text: '历史正文',
      createdAt: run('run-1').createdAt, ...(scope === 'turn' ? { turnId: 'turn-1' } : {}) }];
    const metadataEvent = { ...event('unknown_event', 1, { type: 'unknown_event', rawEventId: identity.rawEventId }), ...identity };
    const done = event('done', 2, { type: 'done', status: 'succeeded', terminationReason: 'completed' });
    const source = [run('run-1')];

    const full = mergeRunEventsIntoThreadHistory(history, source, () => [metadataEvent, done]);
    const filtered = mergeRunEventsIntoThreadHistory(history, source, () => ({ events: [done], identities: [identity] }));

    expect(filtered).toEqual(full);
    expect(filtered.find(item => item.id === 'body')).toMatchObject({ runId: 'run-1' });
  });

  it.each(['inProgress', 'completed'] as const)('Runtime %s 快照不能提前声明 daemon 增量覆盖了后续正文', status => {
    const runtime = mapCodexTurnsPage({ data: [{
      id: 'turn-1', status, startedAt: 1_787_313_456, completedAt: null,
      items: [{ type: 'agentMessage', id: 'body', text: '你好' }]
    }], nextCursor: null });
    expect(runtime.items[0]).toMatchObject({ messageState: status === 'inProgress' ? 'streaming' : 'complete' });
    if (status === 'inProgress') expect(runtime.items.some(item => item.type === 'done')).toBe(false);
    const events = [{ ...event('assistant_message', 1, {
      type: 'assistant_message', text: '你', delivery: 'delta', format: 'plain_text'
    }, 'body'), turnId: 'turn-1' }];
    const source = { ...run('run-1'), status: 'running' as const };
    const partial = mergeRunEventsIntoThreadHistory(runtime.items, [source], () => events);
    expect(partial.filter(item => item.type === 'assistant_message')).toMatchObject([
      { id: 'body', text: '你', messageState: 'streaming', eventSeq: 1 }
    ]);
    events.push({ ...event('assistant_message', 2, {
      type: 'assistant_message', text: '好', delivery: 'delta', format: 'plain_text'
    }, 'body'), turnId: 'turn-1' });
    expect(mergeRunEventsIntoThreadHistory(runtime.items, [source], () => events)
      .filter(item => item.type === 'assistant_message')).toMatchObject([
      { id: 'body', text: '你好', messageState: 'streaming', eventSeq: 2 }
    ]);
    const complete = { ...event('assistant_message', 3, {
      type: 'assistant_message', text: '校正后的全文', delivery: 'message', format: 'plain_text'
    }, 'body'), turnId: 'turn-1' };
    expect(mergeRunEventsIntoThreadHistory(runtime.items, [source], () => [...events, complete])
      .filter(item => item.type === 'assistant_message')).toMatchObject([
      { id: 'body', text: '校正后的全文', messageState: 'complete', eventSeq: 3 }
    ]);
  });

  it('缺少显式归属时不将相隔很久或有多个候选的附件绑定到历史消息', () => {
    const history: ThreadHistoryItem[] = [{ id: 'user', type: 'user_message', text: '继续', createdAt: run('a').createdAt }];
    const distant = { ...run('old'), createdAt: '2026-08-20T00:00:00Z', attachments: [imageAttachment()] };
    expect(attachRunAttachmentsToThreadHistory(history, [distant])).toEqual(history);
    const nearby = ['a', 'b'].map(id => ({ ...run(id), publicPrompt: '继续', attachments: [imageAttachment()] }));
    expect(attachRunAttachmentsToThreadHistory(history, nearby)).toEqual(history);
  });

  it('聚合正文增量，保持首次时间及最新覆盖水位，完成快照精确替换', () => {
    const events = [event('assistant_message', 1, { type: 'assistant_message', text: '你', delivery: 'delta', format: 'plain_text' }, 'body'),
      event('assistant_message', 2, { type: 'assistant_message', text: '好', delivery: 'delta', format: 'plain_text' }, 'body')];
    const source = { ...run('run-1'), status: 'running' as const };
    expect(mergeRunEventsIntoThreadHistory([], [source], () => events)).toMatchObject([
      { id: 'run-1:body', text: '你好', messageState: 'streaming', eventSeq: 2, createdAt: events[0]!.ts }
    ]);
    const complete = event('assistant_message', 3, { type: 'assistant_message', text: '完整校正', delivery: 'message', format: 'plain_text' }, 'body');
    expect(mergeRunEventsIntoThreadHistory([], [source], () => [...events, complete])).toMatchObject([
      { text: '完整校正', messageState: 'complete', eventSeq: 3, createdAt: events[0]!.ts }
    ]);
  });

  it('不同 run 的同秒同文和相同 item ID 均保留，轮内按 seq 排列', () => {
    const items = mergeRunEventsIntoThreadHistory([], [run('b'), run('a')], runId => [
      { ...event('assistant_message', 1, { type: 'assistant_message', text: '好的', delivery: 'message', format: 'plain_text' }, 'body'), runId },
      { ...event('tool_use', 2, { type: 'tool_use', toolCallId: 'call', name: 'test', input: {} }, 'tool'), runId }
    ]);
    expect(items.map(item => [item.runId, item.type])).toEqual([
      ['a', 'assistant_message'], ['a', 'tool_use'], ['b', 'assistant_message'], ['b', 'tool_use']
    ]);
  });

  it('历史回放保留 Codex 错误、重试及结束原因，事件 ID 与实时会话一致', () => {
    const modelResponse = { errorCode: 'other', reason: 'Codex Runtime 返回错误', suggestion: '请稍后重试', retrying: false,
      runtimeMessage: 'Response protection failed', diagnostics: {} };
    const items = mergeRunEventsIntoThreadHistory([], [run('run-1')], () => [
      event('diagnostic', 1, { type: 'diagnostic', severity: 'warning', code: 'CODEX_STREAM_RETRYING', message: '正在重试', modelResponse: { ...modelResponse, retrying: true } }),
      event('error', 2, { type: 'error', code: 'CODEX_STREAM_ERROR', message: modelResponse.reason, modelResponse }),
      event('done', 3, { type: 'done', status: 'failed', terminationReason: 'stream_error' })
    ]);
    expect(items.filter(item => item.type === 'diagnostic')).toMatchObject([
      { id: 'event-1', runId: 'run-1', severity: 'warning', modelResponse: { runtimeMessage: 'Response protection failed', retrying: true } },
      { id: 'event-2', runId: 'run-1', severity: 'error', modelResponse }
    ]);
    expect(items.find(item => item.type === 'done')).toMatchObject({ runId: 'run-1', status: 'failed', terminationReason: 'stream_error' });
  });
  it('保留无文本 MCP 结构化结果及所属 Run', () => {
    const response = { download: { type: 'skill_contributions_csv', query: { report: 'first_approvals' } } };
    const items = mergeRunEventsIntoThreadHistory([], [run('run-1')], () => [
      event('tool_use', 1, { type: 'tool_use', toolCallId: 'export', name: 'skill_contributions_export', input: {} }),
      event('tool_result', 2, { type: 'tool_result', toolCallId: 'export', output: '', response, isError: false })
    ]);
    expect(items.find(item => item.type === 'tool_result')).toMatchObject({
      name: 'skill_contributions_export', output: JSON.stringify(response), runId: 'run-1'
    });
  });
  it('MCP 业务错误在历史回放中保留具体原因和失败状态', () => {
    const result = normalizeAppServerEvent({ runId: 'run-1', seq: 2, raw: {
      method: 'item/completed', params: { item: { type: 'mcpToolCall', id: 'detail', status: 'completed',
        result: { isError: true, content: [], structuredContent: { code: 'content_forbidden', message: '未获授权查看员工会话正文' } }
      } }
    } });
    const items = mergeRunEventsIntoThreadHistory([], [run('run-1')], () => [
      event('tool_use', 1, { type: 'tool_use', toolCallId: 'detail', name: 'agent_detail', input: {} }), result
    ]);
    expect(items.find(item => item.type === 'tool_result')).toMatchObject({
      name: 'agent_detail', output: '未获授权查看员工会话正文（content_forbidden）', isError: true, runId: 'run-1'
    });
  });
  it('同一秒内按时间保留模型回复与异常的先后顺序', () => {
    const modelResponse = { errorCode: 'other', reason: 'Codex Runtime 返回错误', suggestion: '请稍后重试', retrying: true, diagnostics: {} };
    const items = mergeRunEventsIntoThreadHistory([], [run('run-1')], () => [
      event('assistant_message', 1, { type: 'assistant_message', text: '部分回答', delivery: 'message', format: 'plain_text' }),
      event('diagnostic', 2, { type: 'diagnostic', severity: 'warning', code: 'CODEX_STREAM_RETRYING', message: '正在重试', modelResponse }),
      event('done', 3, { type: 'done', status: 'failed', terminationReason: 'stream_error' })
    ]);
    expect(items.filter(item => item.type !== 'user_message').map(item => item.type)).toEqual(['assistant_message', 'diagnostic', 'done']);
  });
  it('明确 turn 关联的失败终态补齐运行归属和结束原因', () => {
    const original: ThreadHistoryItem = { id: 'history_done', type: 'done', terminalSource: 'runtime_turn', status: 'failed', turnId: 'turn-1', createdAt: '2026-08-21T11:57:36.000Z' };
    const items = mergeRunEventsIntoThreadHistory([original], [run('run-1')], () => [
      { ...event('done', 1, { type: 'done', status: 'failed', terminationReason: 'stream_error' }), turnId: 'turn-1' }
    ]);
    expect(items.filter(item => item.type === 'done')).toMatchObject([{ ...original, runId: 'run-1', terminalSource: 'daemon', terminationReason: 'stream_error' }]);
    expect(original).not.toHaveProperty('runId');
  });

  it.each(['history', 'events'] as const)(
    '定时触发已由 %s 表达时不补入重复用户消息',
    source => {
      const trigger: ThreadHistoryItem = {
        id: 'schedule-trigger',
        type: 'schedule_trigger',
        prompt: '生成报告',
        triggeredAt: '2026-08-21T11:57:36.000Z',
        createdAt: '2026-08-21T11:57:36.000Z',
        runId: 'run-1',
        turnId: 'turn-1'
      };
      const result = mergeRunEventsIntoThreadHistory(
        source === 'history' ? [trigger] : [],
        [{ ...run('run-1'), publicPrompt: '生成报告' }],
        () => [
          event('schedule_trigger', 1, {
            type: 'schedule_trigger',
            prompt: '生成报告',
            triggeredAt: trigger.triggeredAt
          }),
          event('assistant_message', 2, {
            type: 'assistant_message',
            text: '报告已生成：[打开报告](report.html)',
            format: 'plain_text',
            delivery: 'message'
          }),
          event('done', 3, {
            type: 'done',
            status: 'succeeded',
            terminationReason: 'completed'
          })
        ]
      );

      expect(result.filter(item => item.type === 'user_message')).toEqual([]);
      expect(result.filter(item => item.type === 'schedule_trigger')).toHaveLength(1);
      expect(result.map(item => item.type)).toEqual([
        'schedule_trigger', 'assistant_message', 'done'
      ]);
    }
  );

  it('跨秒保存的用户消息按 Run 去重，保留其他 Run 的同文输入', () => {
    const history: ThreadHistoryItem[] = [{
      id: 'user-1',
      type: 'user_message',
      text: 'describe these attachments',
      createdAt: '2026-08-21T11:57:37.000Z',
      runId: 'run-1',
      turnId: 'turn-1'
    }];
    const result = mergeRunEventsIntoThreadHistory(
      history,
      [
        {
          ...run('run-2'),
          publicPrompt: 'describe these attachments',
          createdAt: '2026-08-21T11:57:38.000Z'
        },
        { ...run('run-1'), publicPrompt: 'describe these attachments' }
      ],
      () => []
    );

    expect(result).toMatchObject([
      history[0],
      {
        id: 'run-prompt:run-2',
        runId: 'run-2',
        type: 'user_message',
        text: 'describe these attachments',
        createdAt: '2026-08-21T11:57:38.000Z'
      }
    ]);
  });

  it('缺少关联时保留 Runtime 原始顺序，不凭类型把同秒工具前移', () => {
    const history: ThreadHistoryItem[] = [
      {
        id: 'user-1',
        type: 'user_message',
        text: '执行命令',
        createdAt: '2026-08-21T11:57:36.000Z'
      },
      {
        id: 'assistant-1',
        type: 'assistant_message',
        text: '执行完成',
        createdAt: '2026-08-21T11:57:36.000Z'
      },
      {
        id: 'done-1',
        type: 'done',
        status: 'succeeded',
        createdAt: '2026-08-21T11:57:36.000Z'
      }
    ];

    const result = mergeRunEventsIntoThreadHistory(
      history,
      [run('run-1')],
      () => [
        event('tool_use', 1, {
          type: 'tool_use',
          toolCallId: 'call-1',
          name: 'command_execution',
          input: { command: 'printf complete' }
        }),
        event('tool_result', 2, {
          type: 'tool_result',
          toolCallId: 'call-1',
          output: 'complete\n',
          exitCode: 0,
          isError: false
        })
      ]
    );

    expect(result).toMatchObject([
      history[0],
      history[1],
      history[2],
      {
        id: 'run-1:event-1:use',
        type: 'tool_use',
        name: 'command_execution',
        input: { command: 'printf complete' },
        createdAt: '2026-08-21T11:57:36.100Z'
      },
      {
        id: 'run-1:event-2:result',
        type: 'tool_result',
        name: 'command_execution',
        output: 'complete\n',
        isError: false,
        createdAt: '2026-08-21T11:57:36.200Z',
        runId: 'run-1'
      }
    ]);
  });

  it('does not duplicate a rich item already returned by app-server', () => {
    const history: ThreadHistoryItem[] = [{
      id: 'command-1:result',
      type: 'tool_result',
      name: 'command_execution',
      output: 'complete\n',
      isError: false,
      createdAt: '2026-08-21T11:57:36.000Z'
    }];

    const result = mergeRunEventsIntoThreadHistory(
      history,
      [run('run-1')],
      () => [event('tool_result', 1, {
        type: 'tool_result',
        toolCallId: 'command_execution',
        output: 'complete\n',
        exitCode: 0,
        isError: false
      }, 'command-1')]
    );

    expect(result).toMatchObject(history);
  });

  it('keeps only the latest state for one persisted file change item', () => {
    const result = mergeRunEventsIntoThreadHistory(
      [],
      [run('run-1')],
      () => [
        event('file_change', 1, {
          type: 'file_change',
          changes: [{ path: 'result.txt', kind: 'add' }],
          status: 'in_progress'
        }, 'file-1'),
        event('file_change', 2, {
          type: 'file_change',
          changes: [{ path: 'result.txt', kind: 'add' }],
          status: 'completed'
        }, 'file-1')
      ]
    );

    expect(result).toMatchObject([{
      id: 'run-1:file-1',
      type: 'file_change',
      changes: [{ path: 'result.txt', kind: 'add' }],
      status: 'completed',
      createdAt: '2026-08-21T11:57:36.200Z'
    }]);
  });

  it('rebuilds user and assistant messages when Codex history is unavailable', () => {
    const result = mergeRunEventsIntoThreadHistory(
      [],
      [{
        ...run('run-1'),
        publicPrompt: '查找武汉市好玩的地方'
      }],
      () => [
        event('assistant_message', 1, {
          type: 'assistant_message',
          text: '东湖和湖北省博物馆都值得去。',
          format: 'plain_text',
          delivery: 'message'
        }, 'assistant-1'),
        event('done', 2, {
          type: 'done',
          status: 'succeeded',
          terminationReason: 'completed'
        }, 'done-1')
      ]
    );

    expect(result).toMatchObject([
      {
        id: 'run-prompt:run-1',
        type: 'user_message',
        text: '查找武汉市好玩的地方',
        createdAt: '2026-08-21T11:57:36.000Z'
      },
      {
        id: 'run-1:assistant-1',
        type: 'assistant_message',
        text: '东湖和湖北省博物馆都值得去。',
        createdAt: '2026-08-21T11:57:36.100Z'
      },
      {
        id: 'run-1:done-1',
        type: 'done',
        status: 'succeeded',
        runId: 'run-1',
        terminationReason: 'completed',
        createdAt: '2026-08-21T11:57:36.200Z'
      }
    ]);
  });

  it('preserves matching fallback items from distinct runs in one second', () => {
    const result = mergeRunEventsIntoThreadHistory(
      [],
      [
        {
          ...run('run-2'),
          publicPrompt: 'Summarize status'
        },
        {
          ...run('run-1'),
          publicPrompt: 'Summarize status'
        }
      ],
      runId => [{
        ...event('done', 1, {
          type: 'done',
          status: 'succeeded',
          terminationReason: 'completed'
        }, `done-${runId}`),
        runId
      }]
    );

    expect(result).toMatchObject([
      {
        id: 'run-prompt:run-1',
        type: 'user_message',
        text: 'Summarize status',
        createdAt: '2026-08-21T11:57:36.000Z'
      },
      {
        id: 'run-1:done-run-1',
        type: 'done',
        status: 'succeeded',
        runId: 'run-1',
        terminationReason: 'completed',
        createdAt: '2026-08-21T11:57:36.100Z'
      },
      {
        id: 'run-prompt:run-2',
        type: 'user_message',
        text: 'Summarize status',
        createdAt: '2026-08-21T11:57:36.000Z'
      },
      {
        id: 'run-2:done-run-2',
        type: 'done',
        status: 'succeeded',
        runId: 'run-2',
        terminationReason: 'completed',
        createdAt: '2026-08-21T11:57:36.100Z'
      }
    ]);
  });

  it('attaches committed run images to the matching user history item', () => {
    const attachment = imageAttachment();
    const history: ThreadHistoryItem[] = [{
      id: 'user-image',
      type: 'user_message',
      text: 'describe this image',
      createdAt: '2026-08-21T11:57:36.100Z',
      turnId: 'turn-image'
    }];

    const result = mergeRunEventsIntoThreadHistory(
      history,
      [{
        ...run('run-image'),
        publicPrompt: 'describe this image',
        attachments: [attachment]
      }],
      () => []
    );

    expect(result).toEqual([{
      ...history[0],
      runId: 'run-image',
      attachments: [attachment]
    }]);
  });

  it('replaces managed execution context with the persisted public prompt', () => {
    const attachment = imageAttachment();
    const history: ThreadHistoryItem[] = [{
      id: 'user-context',
      type: 'user_message',
      text: '[managed context]\ndescribe these attachments',
      createdAt: '2026-08-21T11:57:36.100Z',
      turnId: 'turn-context'
    }];
    const runs = [{
      ...run('run-context'),
      publicPrompt: 'describe these attachments',
      attachments: [attachment]
    }];

    expect(attachRunAttachmentsToThreadHistory(
      reconcileRunPromptsInThreadHistory(history, runs),
      runs
    )).toEqual([{
      ...history[0],
      text: 'describe these attachments',
      runId: 'run-context',
      attachments: [attachment]
    }]);
  });

  it('attaches images by timestamp when interactive run prompts are not persisted', () => {
    const attachment = imageAttachment();
    const history: ThreadHistoryItem[] = [{
      id: 'user-private-prompt',
      type: 'user_message',
      text: 'private prompt',
      createdAt: '2026-08-21T11:57:36.100Z',
      turnId: 'turn-private-prompt'
    }];

    expect(attachRunAttachmentsToThreadHistory(
      history,
      [{
        ...run('run-image'),
        attachments: [attachment]
      }]
    )).toEqual([{
      ...history[0],
      runId: 'run-image',
      attachments: [attachment]
    }]);
  });

  it('matches repeated prompts by timestamp when enriching an older history page', () => {
    const olderAttachment = {
      ...imageAttachment(),
      id: 'attachment-older',
      runId: 'run-older',
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z'
    };
    const newerAttachment = {
      ...imageAttachment(),
      id: 'attachment-newer',
      runId: 'run-newer',
      createdAt: '2026-08-21T10:00:00.000Z',
      updatedAt: '2026-08-21T10:00:00.000Z'
    };
    const result = attachRunAttachmentsToThreadHistory(
      [{
        id: 'user-older',
        type: 'user_message',
        text: 'describe this image',
        createdAt: '2026-08-20T10:00:01.000Z',
        turnId: 'turn-older'
      }],
      [
        {
          ...run('run-newer'),
          publicPrompt: 'describe this image',
          attachments: [newerAttachment],
          createdAt: '2026-08-21T10:00:01.000Z'
        },
        {
          ...run('run-older'),
          publicPrompt: 'describe this image',
          attachments: [olderAttachment],
          createdAt: '2026-08-20T10:00:01.000Z'
        }
      ]
    );

    expect(result).toEqual([{
      id: 'user-older',
      type: 'user_message',
      text: 'describe this image',
      createdAt: '2026-08-20T10:00:01.000Z',
      turnId: 'turn-older',
      runId: 'run-older',
      attachments: [olderAttachment]
    }]);
  });
});

function imageAttachment(): AttachmentResponse {
  return {
    id: 'attachment-image',
    fileName: 'screen.png',
    mime: 'image/png',
    size: 4,
    sha256: 'a'.repeat(64),
    storageKey: 'aa/attachment-image.bin',
    threadId: 'thread-image',
    runId: 'run-image',
    status: 'committed',
    createdAt: '2026-08-21T11:57:36.000Z',
    updatedAt: '2026-08-21T11:57:36.000Z'
  };
}

function run(id: string) {
  return {
    id,
    createdAt: '2026-08-21T11:57:36.000Z',
    status: 'succeeded' as const
  };
}

function event<Type extends AgentEventEnvelope['type']>(
  type: Type,
  seq: number,
  payload: Extract<
    AgentEventEnvelope,
    { type: Type }
  >['payload'],
  rawEventId?: string
): Extract<AgentEventEnvelope, { type: Type }> {
  return {
    id: `event-${seq}`,
    runId: 'run-1',
    seq,
    ts: `2026-08-21T11:57:36.${seq}00Z`,
    type,
    payload,
    normalizerVersion: 1,
    ...(rawEventId === undefined ? {} : { rawEventId })
  } as Extract<AgentEventEnvelope, { type: Type }>;
}
