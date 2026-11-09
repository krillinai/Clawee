import { describe, expect, it } from 'vitest';
import { previewLegacyOffice } from '../../src/attachments/office-preview.js';

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('旧版 Office 内容结构适配', () => {
  it('保留分段、换行、嵌套文字和表格内容，文档中的 HTML 仍为文字', () => {
    const result = previewLegacyOffice({ sections: [{ elements: [
      { type: 'paragraph', content: [{ type: 'text', text: '<script>正文</script>' }, { type: 'line_break' },
        { type: 'hyperlink', content: [{ type: 'text', text: '链接文字' }] }] },
      { type: 'table', rows: [{ cells: [{ content: [paragraph('0'), paragraph('false')] },
        { content: [paragraph('表格文字')] }] }] }
    ] }] }, 'doc');
    expect(result).toMatchObject({ format: 'doc', truncated: false, blocks: [
      { type: 'paragraph', text: '<script>正文</script>\n链接文字' },
      { type: 'table', rows: [['0\nfalse', '表格文字']] }
    ] });
  });

  it('正文和旧版表格受现有文字、行列额度限制并标记截断', () => {
    expect(previewLegacyOffice({ sections: [{ elements: [paragraph('大'.repeat(210_000))] }] }, 'doc').truncated).toBe(true);
    const result = previewLegacyOffice({ sections: [{ title: '数据', elements: [{ type: 'table',
      rows: Array.from({ length: 1001 }, (_, index) => ({ cells: Array.from({ length: index === 0 ? 101 : 1 }, () => ({ content: [] })) }))
    }] }] }, 'xls');
    expect(result.truncated).toBe(true);
    if (result.format !== 'xls') throw new Error('预览格式错误');
    const table = result.sheets[0]?.blocks[0];
    if (table?.type !== 'table') throw new Error('缺少表格');
    expect(table.rows).toHaveLength(1000);
    expect(table.rows[0]).toHaveLength(100);
  });

  it('工作表与幻灯片保留总数并限制展示数量，缺失信息不伪造', () => {
    const sections = Array.from({ length: 201 }, (_, index) => ({ title: `第 ${index + 1} 项`, elements: [] }));
    const workbook = previewLegacyOffice({ sections }, 'xls');
    expect(workbook).toMatchObject({ format: 'xls', totalSheets: 201, truncated: true });
    if (workbook.format !== 'xls') throw new Error('预览格式错误');
    expect(workbook.sheets).toHaveLength(100);
    expect(workbook.sheets[0]).toEqual({ name: '第 1 项', blocks: [] });
    const presentation = previewLegacyOffice({ sections }, 'ppt');
    expect(presentation).toMatchObject({ format: 'ppt', totalSlides: 201, truncated: true });
    if (presentation.format !== 'ppt') throw new Error('预览格式错误');
    expect(presentation.slides).toHaveLength(200);
    expect(presentation.slides[0]).toEqual({ number: 1, blocks: [], notes: [] });
  });
});
