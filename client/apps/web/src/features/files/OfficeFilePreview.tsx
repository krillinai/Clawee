import type { OfficePreview, OfficePreviewBlock, OfficePreviewCell, OfficePreviewSheet } from '@clawee/protocol';
import { useState } from 'react';
import './office-preview.css';

const ROWS_PER_PAGE = 100;

export function OfficeFilePreview({ preview }: { preview: OfficePreview }) {
  return (
    <div className="file-preview file-preview-office" aria-label="Office 只读内容预览">
      <div className="office-preview-notice">
        <span>只读内容预览 · 图片、图表及原始排版未展示</span>
        {preview.format === 'xls' ? <p>旧版 Excel 仅展示可提取的工作表内容；原始单元格坐标、公式、隐藏状态和合并信息未展示。</p> : null}
        {preview.format === 'ppt' ? <p>旧版 PPT 仅展示可提取的逐页内容；演讲备注未展示。</p> : null}
        {preview.truncated ? <p role="status">内容较多，当前仅展示部分内容；请下载原文件查看完整内容。</p> : null}
      </div>
      {preview.format === 'xlsx' ? <WorkbookPreview preview={preview} /> : preview.format === 'xls' ? <LegacyWorkbookPreview preview={preview} /> : (
        <div className="office-preview-content">
          {preview.format === 'docx' || preview.format === 'doc' ? <div className="office-preview-document"><PreviewBlocks blocks={preview.blocks} /></div> : (
            <div className="office-preview-slides">
              <p className="office-preview-summary">共 {preview.totalSlides} 页</p>
              {preview.slides.length === 0 ? <p>暂无幻灯片内容</p> : preview.slides.map(slide => (
                <article className="office-preview-slide" key={slide.number} aria-label={`第 ${slide.number} 页`}>
                  <h2 className="office-preview-slide-number">第 {slide.number} 页</h2>
                  <PreviewBlocks blocks={slide.blocks} />
                  {slide.notes.length > 0 ? <details className="office-preview-notes"><summary>演讲备注</summary><PreviewBlocks blocks={slide.notes} /></details> : null}
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PreviewBlocks({ blocks }: { blocks: OfficePreviewBlock[] }) {
  if (blocks.length === 0) return <p className="office-preview-summary">无可展示的文字或表格内容</p>;
  return <>{blocks.map((block, index) => {
    if (block.type === 'table') return (
      <div className="office-preview-table-scroll" key={index}>
        <table className="office-preview-table" aria-label="内容表格"><tbody>{block.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>
        ))}</tbody></table>
      </div>
    );
    if (block.type === 'heading') {
      const Heading = `h${block.level ?? 1}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Heading key={index}>{block.text}</Heading>;
    }
    if (block.type === 'list') return <p className="office-preview-list-item" key={index}><span aria-hidden="true">{block.marker}</span>{block.text}</p>;
    return <p key={index} className={block.type === 'unsupported' ? 'office-preview-summary' : undefined}>{block.text}</p>;
  })}</>;
}

function LegacyWorkbookPreview({ preview }: { preview: Extract<OfficePreview, { format: 'xls' }> }) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheet = preview.sheets[sheetIndex];
  return (
    <>
      <div className="office-preview-sheets" role="group" aria-label="工作表">
        {preview.sheets.map((item, index) => <button type="button" key={index} aria-pressed={sheetIndex === index} onClick={() => setSheetIndex(index)}>{item.name}</button>)}
      </div>
      <div className="office-preview-sheet-status">共 {preview.totalSheets} 张工作表</div>
      <div className="office-preview-content">
        {sheet ? <section aria-label={`工作表 ${sheet.name}`}><PreviewBlocks blocks={sheet.blocks} /></section> : <p>暂无可展示的工作表内容</p>}
      </div>
    </>
  );
}

function WorkbookPreview({ preview }: { preview: Extract<OfficePreview, { format: 'xlsx' }> }) {
  const [sheetIndex, setSheetIndex] = useState(() => Math.max(0, preview.sheets.findIndex(sheet => sheet.state === 'visible')));
  const [page, setPage] = useState(0);
  const sheet = preview.sheets[sheetIndex];
  if (!sheet) return <div className="office-preview-content"><p>暂无工作表</p></div>;
  const pages = Math.max(1, Math.ceil(sheet.rowCount / ROWS_PER_PAGE));
  const firstRow = page * ROWS_PER_PAGE + 1;
  const lastRow = Math.min(sheet.rowCount, firstRow + ROWS_PER_PAGE - 1);
  return (
    <>
      <div className="office-preview-sheets" role="group" aria-label="工作表">
        {preview.sheets.map((item, index) => <button type="button" key={index} aria-pressed={sheetIndex === index} onClick={() => { setSheetIndex(index); setPage(0); }}>
          {item.name}{item.state !== 'visible' ? '（隐藏）' : ''}
        </button>)}
      </div>
      <div className="office-preview-sheet-status">
        <p>共 {sheet.totalRows} 行、{sheet.totalColumns} 列 · 公式使用文件保存的结果，可能过期，不重算公式</p>
        {sheet.truncated ? <p>此工作表仅展示部分内容，请下载查看完整数据。</p> : null}
      </div>
      <div className="office-preview-content office-preview-grid-scroll">
        {sheet.rowCount === 0 || sheet.columnCount === 0 ? <p>空工作表</p> : <SheetGrid sheet={sheet} firstRow={firstRow} lastRow={lastRow} />}
      </div>
      <div className="office-preview-pagination">
        <span>{sheet.rowCount > 0 ? `第 ${firstRow}～${lastRow} 行` : '0 行'} · {page + 1} / {pages} 页</span>
        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
        <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </>
  );
}

function SheetGrid({ sheet, firstRow, lastRow }: { sheet: OfficePreviewSheet; firstRow: number; lastRow: number }) {
  const cells = new Map<string, OfficePreviewCell>();
  for (const row of sheet.rows) for (const cell of row.cells) cells.set(`${row.number}:${cell.column}`, cell);
  const merged = new Map<string, { rowSpan: number; colSpan: number; cell?: OfficePreviewCell } | null>();
  for (const merge of sheet.merges) {
    const start = Math.max(merge.row, firstRow);
    const end = Math.min(merge.row + merge.rowSpan - 1, lastRow);
    for (let row = start; row <= end; row += 1) {
      for (let column = merge.column; column < merge.column + merge.columnSpan; column += 1) merged.set(`${row}:${column}`, null);
    }
    if (start <= end) merged.set(`${start}:${merge.column}`, { rowSpan: end - start + 1, colSpan: merge.columnSpan, cell: cells.get(`${merge.row}:${merge.column}`) });
  }
  const columns = Array.from({ length: sheet.columnCount }, (_, index) => index + 1);
  return (
    <table className="office-preview-table office-preview-grid" aria-label={`工作表 ${sheet.name}`}>
      <thead><tr><th scope="col" aria-label="行号" />{columns.map(column => <th scope="col" key={column}>{columnLabel(column)}</th>)}</tr></thead>
      <tbody>{Array.from({ length: lastRow - firstRow + 1 }, (_, index) => firstRow + index).map(row => (
        <tr key={row}><th scope="row">{row}</th>{columns.map(column => {
          const address = `${row}:${column}`;
          const merge = merged.get(address);
          if (merge === null) return null;
          const cell = merge?.cell ?? cells.get(address);
          return <td key={column} rowSpan={merge?.rowSpan} colSpan={merge?.colSpan} title={cell?.formula ? `${columnLabel(column)}${row} · 公式：${cell.formula}` : `${columnLabel(column)}${row}`}>
            {cell?.text ?? ''}
            {cell?.formula ? <span className="office-preview-formula" aria-label={`公式：${cell.formula}`}>ƒx</span> : null}
          </td>;
        })}</tr>
      ))}</tbody>
    </table>
  );
}

function columnLabel(number: number): string {
  let label = '';
  for (let value = number; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + (value - 1) % 26) + label;
  return label;
}
