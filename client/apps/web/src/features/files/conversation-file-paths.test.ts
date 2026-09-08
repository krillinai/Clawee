import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '../../components/timeline/timeline-model.js';
import { collectConversationFilePaths } from './conversation-file-paths.js';

describe('collectConversationFilePaths', () => {
  it('returns only current conversation files with newest results first', () => {
    const items: TimelineItem[] = [
      {
        kind: 'assistant_message',
        id: 'message-old',
        text: '已生成 docs/summary.md，并参考 src/app.ts',
        source: 'runtime'
      },
      {
        kind: 'change_card',
        id: 'change-latest',
        title: '新增 1 个文件',
        path: 'reports/latest.html',
        delta: '1 项变更',
        source: 'runtime'
      },
      {
        kind: 'assistant_message',
        id: 'message-latest',
        text: '最终成果 reports/final.pdf',
        source: 'runtime'
      }
    ];

    expect(collectConversationFilePaths(items)).toEqual([
      'reports/final.pdf',
      'reports/latest.html',
      'docs/summary.md'
    ]);
  });

  it('returns no fallback path when the conversation has no files', () => {
    expect(collectConversationFilePaths([{
      kind: 'assistant_message',
      id: 'message',
      text: '没有生成任何文件',
      source: 'runtime'
    }])).toEqual([]);
  });
});
