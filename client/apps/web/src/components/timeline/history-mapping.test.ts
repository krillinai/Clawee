import type { ThreadHistoryItem } from '@clawee/protocol';
import { describe, expect, it } from 'vitest';
import { createRunReplayDeduper, mergeTimelineHistoryWithCache } from '../../features/runs/run-event-replay.js';
import { mapHistoryItemsToTimelineItems } from './history-mapping.js';
import { eventToTimelineItem } from './timeline-model.js';

const createdAt = '2026-10-14T00:00:00.000Z';

describe('历史消息映射', () => {
  it('Codex 异常历史保留原文、运行归属及失败状态', () => {
    const modelResponse = { errorCode: 'other', reason: 'Codex Runtime 返回错误', suggestion: '请稍后重试', retrying: false,
      runtimeMessage: 'Response protection failed', diagnostics: {} };
    const timeline = mapHistoryItemsToTimelineItems([
      { id: 'user', type: 'user_message', text: '验证异常', runId: 'run-1', createdAt },
      { id: 'error', type: 'diagnostic', severity: 'error', code: 'CODEX_STREAM_ERROR', message: modelResponse.reason, modelResponse, runId: 'run-1', createdAt },
      { id: 'done', type: 'done', terminalSource: 'daemon', status: 'failed', terminationReason: 'stream_error', runId: 'run-1', createdAt }
    ]);
    expect(timeline[1]).toMatchObject({ id: 'error', kind: 'diagnostic', runId: 'run-1', modelResponse });
    expect(timeline[2]).toMatchObject({ kind: 'done', runId: 'run-1', status: 'failed', terminationReason: 'stream_error' });
    const live = eventToTimelineItem({ id: 'error', runId: 'run-1', seq: 1, ts: createdAt, type: 'error', normalizerVersion: 1,
      payload: { type: 'error', code: 'CODEX_STREAM_ERROR', message: modelResponse.reason, modelResponse } });
    expect(createRunReplayDeduper(timeline).shouldAppend(live!)).toBe(false);
  });
  it('不同运行使用相同 Runtime 消息 ID 时保持唯一', () => {
    const items: ThreadHistoryItem[] = [
      { id: 'user-1', type: 'user_message', text: '第一个问题', runId: 'run-1', createdAt },
      { id: 'assistant-1', type: 'assistant_message', text: '第一条回复', createdAt },
      { id: 'user-2', type: 'user_message', text: '第二个问题', runId: 'run-2', createdAt },
      { id: 'assistant-1', type: 'assistant_message', text: '第二条回复', createdAt }
    ];

    const timeline = mapHistoryItemsToTimelineItems(items);

    expect(timeline.filter(item => item.kind === 'assistant_message').map(item => item.id))
      .toEqual(['run-1:assistant-1', 'run-2:assistant-1']);
    expect(new Set(timeline.map(item => item.id)).size).toBe(timeline.length);
  });

  it('历史与流式回复使用相同 ID，避免重放或合并时重复追加', () => {
    const history = mapHistoryItemsToTimelineItems([
      { id: 'user-1', type: 'user_message', text: '分析数据', runId: 'run-1', createdAt },
      { id: 'assistant-1', type: 'assistant_message', text: '完整历史回复', createdAt }
    ]);
    const live = eventToTimelineItem({
      id: 'event-1', rawEventId: 'assistant-1', runId: 'run-1', seq: 1,
      ts: createdAt, type: 'assistant_message', normalizerVersion: 1,
      payload: { type: 'assistant_message', text: '实时回复', format: 'plain_text', delivery: 'message' }
    });

    expect(live).not.toBeNull();
    if (live === null) throw new Error('流式回复未生成时间线消息');
    expect(history.find(item => item.kind === 'assistant_message')?.id).toBe(live.id);
    expect(createRunReplayDeduper(history).shouldAppend(live)).toBe(false);
    expect(mergeTimelineHistoryWithCache(history, [live])).toMatchObject([
      { kind: 'user_message', runId: 'run-1' }, { id: live.id, text: '完整历史回复' }
    ]);
  });

  it('没有运行或轮次信息的旧消息保留原始 ID', () => {
    const timeline = mapHistoryItemsToTimelineItems([
      { id: 'legacy-assistant', type: 'assistant_message', text: '旧回复', createdAt }
    ]);

    expect(timeline).toMatchObject([{ id: 'legacy-assistant', kind: 'assistant_message' }]);
  });
});
