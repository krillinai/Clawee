import type { AgentEventEnvelope } from '@clawee/protocol';
import { describe, expect, it } from 'vitest';
import { mapHistoryItemsToTimelineItems } from '../../components/timeline/history-mapping.js';
import type { TimelineItem } from '../../components/timeline/timeline-model.js';
import { applyRunEventToTimeline } from './run-event-application.js';
import { mergeTimelineHistoryWithCache } from './run-event-replay.js';

const ts = '2026-10-16T00:00:00Z';
function message(seq: number, text: string, delivery: 'delta' | 'message' = 'delta'): AgentEventEnvelope {
  return { id: `e${seq}`, runId: 'r', rawEventId: 'body', seq, ts, type: 'assistant_message',
    normalizerVersion: 2, payload: { type: 'assistant_message', text, delivery, format: 'plain_text' } };
}

function reasoning(seq: number, text: string, delivery: 'delta' | 'summary' = 'delta'): AgentEventEnvelope {
  return { id: `e${seq}`, runId: 'r', rawEventId: 'thinking', seq, ts, type: 'reasoning_summary',
    normalizerVersion: 2, payload: { type: 'reasoning_summary', text, delivery, format: 'plain_text' } };
}

describe('会话一致性', () => {
  it('思考摘要逐段累积，重复和旧事件不追加，完成快照精确替换', () => {
    let items = applyRunEventToTimeline([], reasoning(1, '第一段'));
    expect(items).toMatchObject([{ id: 'r:thinking', text: '第一段', delivery: 'delta' }]);
    items = applyRunEventToTimeline(items, reasoning(2, '\n\n第二段'));
    items = applyRunEventToTimeline(items, reasoning(2, '\n\n第二段'));
    items = applyRunEventToTimeline(items, reasoning(1, '第一段'));
    expect(items).toMatchObject([{ text: '第一段\n\n第二段', eventSeq: 2 }]);
    items = applyRunEventToTimeline(items, reasoning(3, '校正后的摘要', 'summary'));
    expect(items).toMatchObject([{ id: 'r:thinking', text: '校正后的摘要', delivery: 'message', eventSeq: 3 }]);
  });

  it.each([undefined, 1])('思考历史恢复后继续拼接，兼容旧历史水位 %s', eventSeq => {
    const history = mapHistoryItemsToTimelineItems([{ id: 'thinking', rawEventId: 'thinking',
      type: 'reasoning_summary', runId: 'r', text: '第一段', eventSeq, createdAt: ts }]);
    let items = history;
    if (eventSeq === undefined) items = applyRunEventToTimeline(items, reasoning(1, '第一段'));
    items = applyRunEventToTimeline(items, reasoning(2, '第二段'));
    expect(items).toMatchObject([{ id: 'r:thinking', text: '第一段第二段', eventSeq: 2 }]);
    const stale = mapHistoryItemsToTimelineItems([{ id: 'thinking', rawEventId: 'thinking',
      type: 'reasoning_summary', runId: 'r', text: '第一段', eventSeq: 1, createdAt: ts }]);
    expect(mergeTimelineHistoryWithCache(stale, items)).toMatchObject([{ text: '第一段第二段', eventSeq: 2 }]);
  });

  it('思考历史归属校正保留 UI ID，不同运行和摘要项不串文，正文继续正常拼接', () => {
    const history = mapHistoryItemsToTimelineItems([
      { id: 'thinking', rawEventId: 'thinking', turnId: 'turn', type: 'reasoning_summary',
        text: '第一段', eventSeq: 1, createdAt: ts }
    ]);
    let items = mergeTimelineHistoryWithCache([
      { ...history[0]!, id: 'r:thinking', runId: 'r', historyOnly: false }
    ], history);
    items = applyRunEventToTimeline(items, reasoning(2, '第二段'));
    items = applyRunEventToTimeline(items, { ...reasoning(1, '其他运行'), runId: 'next' });
    items = applyRunEventToTimeline(items, { ...reasoning(3, '其他摘要'), rawEventId: 'other' });
    items = applyRunEventToTimeline(items, message(4, '你'));
    items = applyRunEventToTimeline(items, message(5, '好'));
    expect(items).toHaveLength(4);
    expect(items.find(item => item.id === history[0]!.id)).toMatchObject({ text: '第一段第二段', runId: 'r' });
    expect(items.find(item => item.id === 'next:thinking')).toMatchObject({ text: '其他运行' });
    expect(items.find(item => item.id === 'r:other')).toMatchObject({ text: '其他摘要' });
    expect(items.find(item => item.id === 'r:body')).toMatchObject({ text: '你好', messageState: 'streaming' });
  });

  it.each([undefined, 'next'])('中断收尾输出归回旧轮次，新指令 runId=%s', nextRunId => {
    const oldUser: TimelineItem = { kind: 'user_message', id: 'old-user', runId: 'r', text: '读取链接', source: 'runtime' };
    const oldNote: TimelineItem = { kind: 'diagnostic', id: 'old-note', severity: 'info', message: '检查链接', content: '{}', source: 'runtime' };
    const nextUser: TimelineItem = { kind: 'user_message', id: 'next-user', runId: nextRunId, text: '使用钉钉 MCP', runStatus: 'queued', source: 'runtime' };
    const pending: TimelineItem = { kind: 'run_status', id: 'pending', label: 'queued', source: 'runtime' };
    const initial = [oldUser, oldNote, nextUser, pending];
    let items = applyRunEventToTimeline(initial, message(1, '旧回复'));
    expect(items.map(item => item.id)).toEqual(['old-user', 'old-note', 'r:body', 'next-user', 'pending']);
    items = applyRunEventToTimeline(items, message(2, '的收尾'));
    items = applyRunEventToTimeline(items, {
      id: 'old-done', runId: 'r', seq: 3, ts, type: 'done', normalizerVersion: 2,
      payload: { type: 'done', status: 'canceled', terminationReason: 'user_canceled' }
    });
    items = applyRunEventToTimeline(items, { ...message(1, '新回复', 'message'), runId: 'next' });
    expect(items.map(item => item.id)).toEqual(['old-user', 'old-note', 'r:body', 'old-done', 'next-user', 'pending', 'next:body']);
    expect(items[2]).toMatchObject({ runId: 'r', text: '旧回复的收尾', messageState: 'interrupted' });
    expect(items.at(-1)).toMatchObject({ runId: 'next', text: '新回复', messageState: 'complete' });
    expect(items.filter(item => item.kind === 'done')).toHaveLength(1);
    expect(nextUser.runId).toBe(nextRunId);
    expect(initial.map(item => item.id)).toEqual(['old-user', 'old-note', 'next-user', 'pending']);
  });

  it('历史 turn 校正到真实 run 后保留 UI ID，增量继续更新原气泡', () => {
    const history = mapHistoryItemsToTimelineItems([
      { id: 'body', type: 'assistant_message', turnId: 'turn', rawEventId: 'body', eventSeq: 1, messageState: 'streaming', text: '你', createdAt: ts }
    ]);
    const normalized = mergeTimelineHistoryWithCache([
      { ...history[0]!, runId: 'r', historyOnly: false, id: 'r:body' }
    ], history);
    const next = applyRunEventToTimeline(normalized, message(2, '好'));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: history[0]!.id, runId: 'r', text: '你好' });
  });
  it('分页和下一轮输入均不合成终态，显式运行归属优先', () => {
    const items = mapHistoryItemsToTimelineItems([
      { id: 'u1', type: 'user_message', runId: 'a', text: '继续', createdAt: ts },
      { id: 'b1', type: 'assistant_message', runId: 'b', text: '中间回答', createdAt: ts },
      { id: 'u2', type: 'user_message', runId: 'c', text: '继续', createdAt: ts }
    ]);
    expect(items.some(item => item.kind === 'done')).toBe(false);
    expect(items[1]?.runId).toBe('b');
  });

  it('两个增量与完成快照只更新一个气泡，重放与旧快照不回退', () => {
    let items = applyRunEventToTimeline([], message(1, '你'));
    items = applyRunEventToTimeline(items, message(2, '好'));
    items = applyRunEventToTimeline(items, message(2, '好'));
    expect(items).toMatchObject([{ id: 'r:body', text: '你好', messageState: 'streaming', eventSeq: 2 }]);
    const historical = mapHistoryItemsToTimelineItems([{ id: 'body', rawEventId: 'body', type: 'assistant_message',
      runId: 'r', text: '你', eventSeq: 1, messageState: 'streaming', createdAt: ts }]);
    items = mergeTimelineHistoryWithCache(historical, items);
    expect(items[0]).toMatchObject({ text: '你好', eventSeq: 2 });
    items = applyRunEventToTimeline(items, message(3, '校正后的完整回答', 'message'));
    expect(items).toMatchObject([{ id: 'r:body', text: '校正后的完整回答', messageState: 'complete' }]);
  });

  it('最新页保留旧前缀和实时尾部，同文不同运行不合并', () => {
    const cache: TimelineItem[] = [
      { kind: 'user_message', id: 'u1', runId: 'a', text: '继续', source: 'runtime' },
      { kind: 'assistant_message', id: 'a:body', runId: 'a', text: '好的', source: 'runtime' },
      { kind: 'user_message', id: 'u2', runId: 'r', text: '继续', source: 'runtime' },
      ...applyRunEventToTimeline([], message(1, '好'))
    ];
    const page = [cache[2]!, ...applyRunEventToTimeline([], message(2, '好的', 'message'))];
    const merged = mergeTimelineHistoryWithCache(page, cache, 'latest');
    expect(merged.map(item => item.id)).toEqual(['u1', 'a:body', 'u2', 'r:body']);
    expect(mergeTimelineHistoryWithCache(page, merged, 'latest')).toEqual(merged);
    expect(mergeTimelineHistoryWithCache([], merged, 'older')).toEqual(merged);
  });
});
