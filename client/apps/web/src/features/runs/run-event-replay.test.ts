import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '../../components/timeline/timeline-model.js';
import { createRunReplayDeduper, mergeTimelineHistoryWithCache } from './run-event-replay.js';

const user = (id: string, runId: string, text = '继续'): Extract<TimelineItem, { kind: 'user_message' }> => ({ kind: 'user_message', id, runId, text, source: 'runtime' });
const body = (id: string, runId: string, text = '好的'): Extract<TimelineItem, { kind: 'assistant_message' }> => ({ kind: 'assistant_message', id, runId, text, source: 'runtime' });
const tool = (id: string, runId: string, phase: string): TimelineItem => ({ kind: 'tool_step', id, runId, rawEventId: 'call', name: 'test', content: JSON.stringify({ type: phase }), source: 'runtime' });

describe('运行重放和历史窗口协调', () => {
  it.each(['latest', 'older', 'search'] as const)('%s 历史同步修正中断时的轮次交错，并保留实时正文和消息 ID', mode => {
    const cached: TimelineItem[] = [
      user('old-user', 'a'), body('old-intro', 'a', '旧任务说明'),
      { ...user('next-user', 'b'), attachmentPreviewUrls: { image: 'blob:preview' } },
      tool('late-tool', 'a', 'tool_result'),
      { ...body('late-body', 'a', '旧任务收尾'), eventSeq: 3, messageState: 'complete' },
      { kind: 'done', id: 'old-done', runId: 'a', status: 'canceled', content: '{}', source: 'runtime' },
      { ...body('live-body', 'b', '新任务实时输出'), eventSeq: 5, messageState: 'streaming' }
    ];
    const history: TimelineItem[] = [
      user('history-old-user', 'a'), cached[1]!, cached[3]!,
      { ...body('late-body', 'a', '旧快照'), eventSeq: 2 }, cached[5]!,
      user('history-next-user', 'b'), { ...body('live-body', 'b', '过期的新任务快照'), eventSeq: 4 }
    ];
    const merged = mergeTimelineHistoryWithCache(history, cached, mode);
    expect(merged.map(item => item.id)).toEqual(['old-user', 'old-intro', 'late-tool', 'late-body', 'old-done', 'next-user', 'live-body']);
    expect(merged[3]).toMatchObject({ text: '旧任务收尾', eventSeq: 3 });
    expect(merged[5]).toMatchObject({ attachmentPreviewUrls: { image: 'blob:preview' } });
    expect(merged[6]).toMatchObject({ text: '新任务实时输出', eventSeq: 5, messageState: 'streaming' });
    expect(mergeTimelineHistoryWithCache(history, merged, mode)).toEqual(merged);
    expect(cached[2]?.id).toBe('next-user');
  });

  it('首次加载大量工具历史时不反复解析工具结果', () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      ...tool(`tool-${index}`, 'r', 'tool_result'), rawEventId: `call-${index}`
    }));
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(mergeTimelineHistoryWithCache(history, [])).toEqual(history);
      expect(parse.mock.calls.length).toBeLessThan(history.length * 3);
    } finally {
      parse.mockRestore();
    }
  });

  it('重访同一历史页时每个大型工具结果只解析常数次', () => {
    const history = Array.from({ length: 40 }, (_, index): TimelineItem => ({
      kind: 'tool_step', id: `tool-${index}`, runId: 'r', rawEventId: `call-${index}`,
      name: 'test', content: JSON.stringify({ type: 'tool_result', output: 'x'.repeat(32_768) }), source: 'runtime'
    }));
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(mergeTimelineHistoryWithCache(history, history.map(item => ({ ...item })))).toHaveLength(history.length);
      expect(parse.mock.calls.length).toBeLessThan(history.length * 4);
    } finally {
      parse.mockRestore();
    }
  });

  it('无共同锚点时只按轮次边界插入，排队的新输入不能拆开旧轮次', () => {
    const cached = [{ ...user('a', 'a'), timestamp: '2026-10-16T00:00:00Z' },
      { ...body('aa', 'a'), timestamp: '2026-10-16T00:00:03Z' }];
    const latest = [{ ...user('b', 'b'), timestamp: '2026-10-16T00:00:02Z' },
      { ...body('bb', 'b'), timestamp: '2026-10-16T00:00:04Z' }];
    expect(mergeTimelineHistoryWithCache(latest, cached).map(item => item.id)).toEqual(['a', 'aa', 'b', 'bb']);
  });
  it('按指定运行去重，后台运行不使用列表末轮作为窗口', () => {
    const deduper = createRunReplayDeduper([user('ua', 'a'), body('aa', 'a'), user('ub', 'b'), body('ab', 'b')], 'a');
    expect(deduper.shouldAppend(body('replay-a', 'a'))).toBe(false);
    expect(deduper.shouldAppend(body('new-c', 'c'))).toBe(true);
    expect(deduper.shouldAppend(body('new-a', 'a'))).toBe(true);
  });

  it('旧历史内容兜底按出现次数消费，明确 item ID 不按正文匹配', () => {
    const deduper = createRunReplayDeduper([body('a', 'r'), { ...body('b', 'r'), rawEventId: 'stable' }], 'r');
    expect(deduper.shouldAppend(body('old-1', 'r'))).toBe(false);
    expect(deduper.shouldAppend(body('old-2', 'r'))).toBe(true);
    expect(deduper.shouldAppend({ ...body('r:stable', 'r'), rawEventId: 'stable' })).toBe(false);
  });

  it('终态回放进入应用函数补齐失败原因，不按成功状态去重', () => {
    const done: TimelineItem = { kind: 'done', id: 'done', runId: 'r', status: 'failed', content: '{}', source: 'runtime' };
    expect(createRunReplayDeduper([done], 'r').shouldAppend({ ...done, terminationReason: 'stream_error' })).toBe(true);
  });

  it('最新页保留前缀、当前流式尾部和逐项额外过程信息', () => {
    const cached = [user('old', 'a'), body('old-body', 'a'), user('new', 'b'), tool('tool', 'b', 'tool_use'), body('live', 'b')];
    const merged = mergeTimelineHistoryWithCache([user('history-new', 'b'), body('live', 'b', '完成快照')], cached, 'latest');
    expect(merged.map(item => item.id)).toEqual(['old', 'old-body', 'new', 'tool', 'live']);
    expect(merged.at(-1)).toMatchObject({ text: '完成快照' });
    expect(mergeTimelineHistoryWithCache([user('history-new', 'b'), body('live', 'b', '完成快照')], merged)).toEqual(merged);
  });

  it('旧页前插时不改动当前流式尾部', () => {
    const cached = [user('new', 'b'), body('live', 'b')];
    const older = [user('old', 'a'), body('old-body', 'a'), user('new', 'b')];
    expect(mergeTimelineHistoryWithCache(older, cached, 'older').map(item => item.id)).toEqual(['old', 'old-body', 'new', 'live']);
  });

  it('同文、同秒但不同 run 的正文与工具均保留', () => {
    const cached = [user('a', 'a'), body('ba', 'a'), tool('ta', 'a', 'tool_use')];
    const incoming = [user('b', 'b'), body('bb', 'b'), tool('tb', 'b', 'tool_use')];
    expect(mergeTimelineHistoryWithCache(incoming, cached)).toHaveLength(6);
  });

  it('工具 use/result 的阶段身份不同', () => {
    expect(mergeTimelineHistoryWithCache([tool('result', 'r', 'tool_result')], [tool('use', 'r', 'tool_use')])).toHaveLength(2);
  });

  it('缺少身份和时间的相同文本保留，不能猜测对应轮次', () => {
    const cached = [{ ...user('optimistic', 'r'), runId: undefined }];
    expect(mergeTimelineHistoryWithCache([user('history', 'other')], cached)).toHaveLength(2);
  });

  it('用户项按 run 校正内容但保留已挂载 ID 和附件预览', () => {
    const cached: TimelineItem = { ...user('optimistic', 'r'), attachmentPreviewUrls: { image: 'blob:preview' } } as TimelineItem;
    const merged = mergeTimelineHistoryWithCache([user('history', 'r', '规范化输入')], [cached]);
    expect(merged).toMatchObject([{ id: 'optimistic', text: '规范化输入', attachmentPreviewUrls: { image: 'blob:preview' }, historyIds: ['history'] }]);
  });

  it('重复输入的附件预览只匹配同一个 run', () => {
    const cached: TimelineItem = { ...user('a', 'a'), attachmentPreviewUrls: { image: 'blob:a' } } as TimelineItem;
    const merged = mergeTimelineHistoryWithCache([user('b', 'b'), user('history-a', 'a')], [cached]);
    expect(merged[0]).not.toHaveProperty('attachmentPreviewUrls');
    expect(merged[1]).toMatchObject({ id: 'a', attachmentPreviewUrls: { image: 'blob:a' } });
  });

  it('缓存中尚未持久化的用户输入仍位于同 run 过程之前', () => {
    const cached = [user('u', 'r'), tool('tool', 'r', 'tool_use')];
    expect(mergeTimelineHistoryWithCache([tool('tool', 'r', 'tool_use')], cached).map(item => item.id)).toEqual(['u', 'tool']);
  });
});
