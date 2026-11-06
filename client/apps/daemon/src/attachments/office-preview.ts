import type { OfficePreview, OfficePreviewBlock, OfficePreviewCell, OfficePreviewSheet } from '@clawee/protocol';
import type { OfficeContentNode } from 'officeparser';

const MAX_PREVIEW_CHARS = 200_000;
const MAX_PREVIEW_ITEMS = 20_000;
const MAX_SHEETS = 100;
const MAX_SLIDES = 200;
const MAX_ROWS = 1000;
const MAX_COLUMNS = 100;

function previewBudget() {
  let chars = 0;
  let items = 0;
  let truncated = false;
  return {
    get full() { return chars >= MAX_PREVIEW_CHARS || items >= MAX_PREVIEW_ITEMS; },
    get truncated() { return truncated; },
    omit() { truncated = true; },
    text(value: string) {
      items += 1;
      const remaining = Math.max(0, MAX_PREVIEW_CHARS - chars);
      if (value.length > remaining || items > MAX_PREVIEW_ITEMS) truncated = true;
      const text = items > MAX_PREVIEW_ITEMS ? '' : value.slice(0, remaining);
      chars += text.length;
      return text + (text.length < value.length ? '…' : '');
    }
  };
}

type PreviewBudget = ReturnType<typeof previewBudget>;

type LegacyNode = {
  type: string;
  text?: string;
  content?: LegacyNode[];
  rows?: Array<{ cells: Array<{ content: LegacyNode[] }> }>;
};

type LegacyDocument = { sections: Array<{ title?: string; elements: LegacyNode[] }> };

function legacyText(nodes: LegacyNode[], budget: PreviewBudget): string {
  let text = '';
  for (const [index, node] of nodes.entries()) {
    if (budget.full) { budget.omit(); break; }
    budget.text('');
    if (node.text !== undefined) text += budget.text(node.text.replace(/\r\n?/g, '\n'));
    else if (node.type === 'line_break') text += budget.text('\n');
    else if (node.type === 'tab') text += budget.text('\t');
    else if (node.content) text += legacyText(node.content, budget);
    else if (node.rows) {
      text += legacyTable(node.rows, budget).map(row => row.join('\t')).join('\n');
    }
    if (node.type === 'paragraph' && index + 1 < nodes.length) text += budget.text('\n');
  }
  return text;
}

function legacyTable(rows: NonNullable<LegacyNode['rows']>, budget: PreviewBudget): string[][] {
  const result: string[][] = [];
  if (rows.length > MAX_ROWS) budget.omit();
  for (const row of rows.slice(0, MAX_ROWS)) {
    if (budget.full) { budget.omit(); break; }
    budget.text('');
    const cells: string[] = [];
    if (row.cells.length > MAX_COLUMNS) budget.omit();
    for (const cell of row.cells.slice(0, MAX_COLUMNS)) {
      if (budget.full) { budget.omit(); break; }
      budget.text('');
      cells.push(legacyText(cell.content, budget));
    }
    result.push(cells);
  }
  return result;
}

function legacyBlocks(nodes: LegacyNode[], budget: PreviewBudget): OfficePreviewBlock[] {
  const blocks: OfficePreviewBlock[] = [];
  for (const node of nodes) {
    if (budget.full) { budget.omit(); break; }
    budget.text('');
    if (node.type === 'table' && node.rows) {
      blocks.push({ type: 'table', rows: legacyTable(node.rows, budget) });
    } else {
      const text = legacyText([node], budget);
      if (text) blocks.push({ type: 'paragraph', text });
    }
  }
  return blocks;
}

export function previewLegacyOffice(document: LegacyDocument, format: 'doc' | 'xls' | 'ppt'): OfficePreview {
  const budget = previewBudget();
  if (format === 'doc') {
    const blocks: OfficePreviewBlock[] = [];
    for (const section of document.sections) {
      if (budget.full) { budget.omit(); break; }
      budget.text('');
      blocks.push(...legacyBlocks(section.elements, budget));
    }
    return { format, blocks, truncated: budget.truncated };
  }
  if (format === 'xls') {
    const sheets = [];
    for (const section of document.sections) {
      if (budget.full || sheets.length >= MAX_SHEETS) { budget.omit(); break; }
      sheets.push({ name: budget.text(section.title ?? `工作表 ${sheets.length + 1}`), blocks: legacyBlocks(section.elements, budget) });
    }
    return { format, sheets, totalSheets: document.sections.length, truncated: budget.truncated };
  }
  const slides = [];
  for (const section of document.sections) {
    if (budget.full || slides.length >= MAX_SLIDES) { budget.omit(); break; }
    budget.text('');
    slides.push({ number: slides.length + 1, blocks: legacyBlocks(section.elements, budget), notes: [] });
  }
  return { format, slides, totalSlides: document.sections.length, truncated: budget.truncated };
}

function previewBlocks(nodes: OfficeContentNode[], budget: PreviewBudget): OfficePreviewBlock[] {
  const blocks: OfficePreviewBlock[] = [];
  for (const node of nodes) {
    if (budget.full) { budget.omit(); break; }
    if (node.type === 'table') {
      budget.text('');
      const rows: string[][] = [];
      for (const row of node.children ?? []) {
        if (budget.full) { budget.omit(); break; }
        budget.text('');
        const cells: string[] = [];
        for (const cell of row.children ?? []) {
          if (budget.full) { budget.omit(); break; }
          cells.push(budget.text(cell.text ?? ''));
        }
        rows.push(cells);
      }
      blocks.push({ type: 'table', rows });
    } else if (['image', 'chart', 'drawing', 'embed'].includes(node.type)) {
      blocks.push({ type: 'unsupported', text: budget.text('图片、图表或嵌入对象未展示') });
    } else if (node.type === 'heading') {
      blocks.push({ type: 'heading', level: Math.max(1, Math.min(6, node.metadata?.level ?? 1)), text: budget.text(node.text ?? '') });
    } else if (node.type === 'list') {
      blocks.push({ type: 'list', marker: node.metadata?.listType === 'ordered' ? `${(node.metadata.itemIndex ?? 0) + 1}.` : '•', text: budget.text(node.text ?? '') });
    } else if (node.text) {
      blocks.push({ type: 'paragraph', text: budget.text(node.text) });
    } else if (node.children) {
      blocks.push(...previewBlocks(node.children, budget));
    }
  }
  return blocks;
}

export function previewDocument(nodes: OfficeContentNode[]): OfficePreview {
  const budget = previewBudget();
  const blocks = previewBlocks(nodes, budget);
  return { format: 'docx', blocks, truncated: budget.truncated };
}

export type PresentationSlide = { number: number; children: OfficeContentNode[]; notes: OfficeContentNode[] };

export function previewPresentation(source: Iterable<PresentationSlide>, totalSlides: number): OfficePreview {
  const budget = previewBudget();
  const slides = [];
  for (const slide of source) {
    if (budget.full || slides.length >= MAX_SLIDES) { budget.omit(); break; }
    slides.push({ number: slide.number, blocks: previewBlocks(slide.children, budget), notes: previewBlocks(slide.notes, budget) });
  }
  return { format: 'pptx', slides, totalSlides, truncated: budget.truncated };
}

export async function previewWorkbook(content: Buffer): Promise<OfficePreview> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(content).buffer, { ignoreNodes: ['drawing', 'tableParts'] });
  const budget = previewBudget();
  const sheets: OfficePreviewSheet[] = [];
  for (const sheet of workbook.worksheets) {
    if (budget.full || sheets.length >= MAX_SHEETS) { budget.omit(); break; }
    const rowCount = Math.min(sheet.rowCount, MAX_ROWS);
    const columnCount = Math.min(sheet.columnCount, MAX_COLUMNS);
    const result: OfficePreviewSheet = {
      name: budget.text(sheet.name), state: sheet.state,
      totalRows: sheet.rowCount, totalColumns: sheet.columnCount, rowCount, columnCount,
      rows: [], merges: [], truncated: sheet.rowCount > rowCount || sheet.columnCount > columnCount
    };
    for (let number = 1; number <= rowCount; number += 1) {
      if (budget.full) { budget.omit(); result.truncated = true; result.rowCount = number - 1; break; }
      const cells: OfficePreviewCell[] = [];
      sheet.getRow(number).eachCell((cell, column) => {
        if (column > columnCount || cell.isMerged && cell.master.address !== cell.address) return;
        if (budget.full) { budget.omit(); result.truncated = true; return; }
        const formula = cell.formula;
        const value = formula ? cell.result : cell.value;
        const text = formula && (value === undefined || value === null) ? '无缓存结果'
          : value instanceof Date ? value.toISOString().replace(/T00:00:00\.000Z$/, '')
            : formula ? typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : String(value)
              : cell.text;
        cells.push({ column, text: budget.text(text), ...(formula ? { formula: budget.text(formula) } : {}) });
      });
      if (cells.length > 0) result.rows.push({ number, cells });
    }
    for (const range of sheet.model.merges) {
      if (budget.full) { budget.omit(); result.truncated = true; break; }
      const bounds = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (!bounds) continue;
      const columnNumber = (letters: string) => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
      const row = Number(bounds[2]);
      const column = columnNumber(bounds[1]!);
      if (row > result.rowCount || column > columnCount) continue;
      budget.text('');
      result.merges.push({ row, column, rowSpan: Math.min(Number(bounds[4]), result.rowCount) - row + 1,
        columnSpan: Math.min(columnNumber(bounds[3]!), columnCount) - column + 1 });
    }
    result.truncated ||= budget.truncated;
    sheets.push(result);
  }
  return { format: 'xlsx', sheets, totalSheets: workbook.worksheets.length, truncated: budget.truncated || sheets.some(sheet => sheet.truncated) };
}
