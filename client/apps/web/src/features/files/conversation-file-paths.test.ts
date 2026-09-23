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

  it('uses the markdown file link target without adding an invalid basename fallback', () => {
    expect(collectConversationFilePaths([{
      kind: 'assistant_message',
      id: 'message',
      text: '[`clawee-user-guide.pdf`](/workspace/output/pdf/clawee-user-guide.pdf:1)',
      source: 'runtime'
    }])).toEqual(['/workspace/output/pdf/clawee-user-guide.pdf']);
  });

  it('includes generated images in the current conversation files', () => {
    expect(collectConversationFilePaths([{
      kind: 'assistant_message',
      id: 'generated-image',
      text: '![杨泗港大桥](outputs/arose-imagegen/bridge.png)',
      source: 'runtime'
    }])).toEqual(['outputs/arose-imagegen/bridge.png']);
  });
});
