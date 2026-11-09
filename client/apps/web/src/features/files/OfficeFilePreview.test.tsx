import type { OfficePreview, OfficePreviewSheet } from '@clawee/protocol';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FileEditorPane } from './FileEditorPane.js';
import { OfficeFilePreview } from './OfficeFilePreview.js';

function sheet(overrides: Partial<OfficePreviewSheet> = {}): OfficePreviewSheet {
  return { name: '汇总', state: 'visible', totalRows: 3, totalColumns: 3, rowCount: 3, columnCount: 3,
    rows: [{ number: 1, cells: [{ column: 1, text: '合并标题' }] }, { number: 3, cells: [
      { column: 1, text: '0' }, { column: 2, text: 'false' }, { column: 3, text: '无缓存结果', formula: 'A3*2' }
    ] }], merges: [{ row: 1, column: 1, rowSpan: 1, columnSpan: 2 }], truncated: false, ...overrides };
}

describe('Office 只读预览', () => {
  it.each(['doc', 'docx'] as const)('Word %s 展示结构并将文档中的 HTML 当文字处理，不提供编辑保存入口', format => {
    render(<FileEditorPane meta={{ path: `报告.${format}`, name: `报告.${format}`, type: 'file', kind: 'office', mime: format === 'doc' ? 'application/msword' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100, mtimeMs: 1, versionToken: 'v1', previewable: true, editable: false, readonly: false }}
      officePreview={{ format, truncated: false, blocks: [
        { type: 'heading', level: 2, text: '核对内容' },
        { type: 'paragraph', text: '<script>alert(1)</script><img src="https://example.invalid/a">' },
        { type: 'list', text: '第一项', marker: '1.' },
        { type: 'table', rows: [['姓名', '数量'], ['张三', '10']] },
        { type: 'unsupported', text: '图片、图表或嵌入对象未展示' }
      ] }} />);
    expect(screen.getByRole('heading', { name: '核对内容', level: 2 })).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('张三')).toBeInTheDocument();
    expect(screen.getByText(/<script>alert/)).toBeInTheDocument();
    expect(document.querySelector('script, img, iframe, [contenteditable="true"]')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('旧版 Excel 可切换内容工作表，不暗示原始坐标、公式或隐藏状态可用', () => {
    render(<OfficeFilePreview preview={{ format: 'xls', totalSheets: 2, truncated: false, sheets: [
      { name: '旧版汇总', blocks: [{ type: 'table', rows: [['名称', '内容'], ['核对', '<img src="https://example.invalid/a">']] }] },
      { name: '旧版明细', blocks: [] }
    ] }} />);
    expect(screen.getByText(/原始单元格坐标、公式、隐藏状态和合并信息未展示/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '工作表 旧版汇总' })).getByRole('table')).toHaveTextContent('核对');
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
    expect(screen.queryByRole('rowheader')).not.toBeInTheDocument();
    expect(screen.queryByText(/公式使用文件保存的结果/)).not.toBeInTheDocument();
    expect(document.querySelector('img, iframe, script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '旧版明细' }));
    expect(screen.getByRole('region', { name: '工作表 旧版明细' })).toHaveTextContent('无可展示的文字或表格内容');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('旧版 PPT 展示页内容并明确告知备注未展示', () => {
    render(<OfficeFilePreview preview={{ format: 'ppt', truncated: false, totalSlides: 1,
      slides: [{ number: 1, blocks: [{ type: 'paragraph', text: '旧版幻灯片正文' }], notes: [] }] }} />);
    expect(screen.getByRole('article', { name: '第 1 页' })).toHaveTextContent('旧版幻灯片正文');
    expect(screen.getByText(/演讲备注未展示/)).toBeInTheDocument();
    expect(screen.queryByText('演讲备注', { exact: true })).not.toBeInTheDocument();
  });

  it('Excel 保留行列坐标、零值、公式提示、合并区域并可切换工作表', () => {
    render(<OfficeFilePreview preview={{ format: 'xlsx', totalSheets: 2, truncated: false, sheets: [sheet(), sheet({ name: '明细', rows: [], merges: [], rowCount: 0, columnCount: 0, totalRows: 0, totalColumns: 0 })] }} />);
    const table = screen.getByRole('table', { name: '工作表 汇总' });
    expect(within(table).getByText('合并标题')).toHaveAttribute('colspan', '2');
    expect(within(table).getByRole('columnheader', { name: 'C' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: '3' })).toBeInTheDocument();
    expect(within(table).getByText('false')).toBeInTheDocument();
    expect(within(table).getByLabelText('公式：A3*2')).toBeInTheDocument();
    expect(within(table).getByText('无缓存结果')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '明细' }));
    expect(screen.getByText('空工作表')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('Excel 分页不丢失跨页合并值，切换工作表重置页码，隐藏工作表有标记', () => {
    render(<OfficeFilePreview preview={{ format: 'xlsx', totalSheets: 2, truncated: false, sheets: [sheet({
      rowCount: 105, totalRows: 105, merges: [{ row: 100, column: 1, rowSpan: 3, columnSpan: 2 }],
      rows: [{ number: 100, cells: [{ column: 1, text: '跨页内容' }] }]
    }), sheet({ name: '隐藏明细', state: 'hidden' })] }} />);
    expect(screen.getByText('跨页内容')).toHaveAttribute('rowspan', '1');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('跨页内容')).toHaveAttribute('rowspan', '2');
    expect(screen.getByRole('rowheader', { name: '101' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '隐藏明细（隐藏）' }));
    expect(screen.getByRole('rowheader', { name: '1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  });

  it('PPT 按页展示表格和可展开备注，截断内容明确提示', () => {
    const preview: OfficePreview = { format: 'pptx', totalSlides: 3, truncated: true, slides: [
      { number: 1, blocks: [{ type: 'paragraph', text: '第一页' }], notes: [{ type: 'paragraph', text: '给演讲者的备注' }] },
      { number: 2, blocks: [{ type: 'table', rows: [['指标', '42']] }], notes: [] }
    ] };
    render(<OfficeFilePreview preview={preview} />);
    expect(screen.getByRole('status')).toHaveTextContent('仅展示部分内容');
    expect(screen.getByText('共 3 页')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: '第 1 页' })).getByText('第一页')).toBeInTheDocument();
    fireEvent.click(screen.getByText('演讲备注'));
    expect(screen.getByText('演讲备注').closest('details')).toHaveAttribute('open');
    expect(within(screen.getByRole('article', { name: '第 2 页' })).getByRole('table')).toHaveTextContent('42');
  });
});
