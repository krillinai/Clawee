import type {
  AgentEventEnvelope,
  AttachmentResponse,
  ThreadHistoryItem
} from '@clawee/protocol';
import { describe, expect, it } from 'vitest';
import {
  attachRunAttachmentsToThreadHistory,
  mergeRunEventsIntoThreadHistory,
  reconcileRunPromptsInThreadHistory
} from '../../src/threads/run-event-history.js';

describe('run event thread history', () => {
  it('inserts persisted tool events before the matching assistant message', () => {
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

    expect(result).toEqual([
      history[0],
      {
        id: 'run-event:event-1',
        type: 'tool_use',
        name: 'command_execution',
        input: { command: 'printf complete' },
        createdAt: '2026-08-21T11:57:36.100Z'
      },
      {
        id: 'run-event:event-2',
        type: 'tool_result',
        name: 'command_execution',
        output: 'complete\n',
        isError: false,
        createdAt: '2026-08-21T11:57:36.200Z'
      },
      history[1],
      history[2]
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

    expect(result).toEqual(history);
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

    expect(result).toEqual([{
      id: 'file-1',
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

    expect(result).toEqual([
      {
        id: 'run-prompt:run-1',
        type: 'user_message',
        text: '查找武汉市好玩的地方',
        createdAt: '2026-08-21T11:57:36.000Z'
      },
      {
        id: 'assistant-1',
        type: 'assistant_message',
        text: '东湖和湖北省博物馆都值得去。',
        createdAt: '2026-08-21T11:57:36.100Z'
      },
      {
        id: 'done-1',
        type: 'done',
        status: 'succeeded',
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

    expect(result).toEqual([
      {
        id: 'run-prompt:run-1',
        type: 'user_message',
        text: 'Summarize status',
        createdAt: '2026-08-21T11:57:36.000Z'
      },
      {
        id: 'run-prompt:run-2',
        type: 'user_message',
        text: 'Summarize status',
        createdAt: '2026-08-21T11:57:36.000Z'
      },
      {
        id: 'done-run-1',
        type: 'done',
        status: 'succeeded',
        createdAt: '2026-08-21T11:57:36.100Z'
      },
      {
        id: 'done-run-2',
        type: 'done',
        status: 'succeeded',
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
