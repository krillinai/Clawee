import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { WorkspaceOfficePreviewResponse } from '@clawee/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../helpers/build-server.js';
import { createDocx, createPptx, createXlsx, officeZip, pptxFiles } from '../helpers/office-fixtures.js';
import { strFromU8, unzipSync } from 'fflate';
import { processOfficeAttachment } from '../../src/attachments/office.js';
import ExcelJS from 'exceljs';

let server: FastifyInstance;
let directory = '';
let workspace = '';
let threadId = '';
let projectId = '';
const headers = { authorization: 'Bearer secret' };

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'clawee-office-preview-'));
  workspace = join(directory, 'workspace');
  mkdirSync(workspace);
  server = await buildServer({ token: 'secret', dataDir: join(directory, 'runtime') });
  const project = await server.inject({ method: 'POST', url: '/projects', headers, payload: { cwd: workspace, name: '内容预览' } });
  projectId = project.json().project.id;
  const thread = await server.inject({ method: 'POST', url: '/threads', headers, payload: { projectId, sandbox: 'read-only' } });
  threadId = thread.json().thread.id;
});

afterEach(async () => {
  await server?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function url(path: string, endpoint = 'office-preview') {
  return `/workspace/files/${endpoint}?${new URLSearchParams({ threadId, path })}`;
}

async function preview(path: string): Promise<WorkspaceOfficePreviewResponse> {
  const response = await server.inject({ url: url(path), headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json();
}

describe('工作区 Office 只读内容预览', () => {
  it.each(['doc', 'xls', 'ppt'] as const)('旧版 %s 可预览真实内容、下载原字节且不可编辑', async format => {
    const bytes = readFileSync(new URL(`../fixtures/legacy-office/simple.${format}`, import.meta.url));
    const path = `旧版 核对.${format}`;
    writeFileSync(join(workspace, path), bytes);
    const result = await preview(path);
    expect(result.meta).toMatchObject({ kind: 'office', previewable: true, editable: false });
    expect(result.preview).toMatchObject({ format, truncated: false });
    if (result.preview.format === 'doc') {
      expect(JSON.stringify(result.preview.blocks)).toContain('This is a simple file created with Word 97-SR2.');
    } else if (result.preview.format === 'xls') {
      expect(result.preview.totalSheets).toBe(3);
      expect(result.preview.sheets.map(sheet => sheet.name)).toEqual(['Sheet1', 'Sheet2', 'Sheet3']);
      expect(result.preview.sheets[0]?.blocks).toContainEqual({ type: 'table', rows: [['replaceMe']] });
      expect(result.preview.sheets[0]).not.toHaveProperty('state');
      expect(result.preview.sheets[0]).not.toHaveProperty('totalRows');
    } else if (result.preview.format === 'ppt') {
      expect(result.preview.totalSlides).toBe(2);
      expect(JSON.stringify(result.preview.slides[0]?.blocks)).toContain('This is a test title');
      expect(JSON.stringify(result.preview.slides[1]?.blocks)).toContain('This is page two');
      expect(result.preview.slides.every(slide => slide.notes.length === 0)).toBe(true);
    }
    const download = await server.inject({ url: url(path, 'download'), headers });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(bytes);
    const writable = await server.inject({ method: 'POST', url: '/threads', headers,
      payload: { projectId, sandbox: 'workspace-write' } });
    const saved = await server.inject({ method: 'POST', url: '/workspace/files/content', headers,
      payload: { threadId: writable.json().thread.id, path, content: '不能覆盖', baseVersionToken: result.meta.versionToken } });
    expect(saved.json().error.code).toBe('FILE_NOT_EDITABLE');
    expect(readFileSync(join(workspace, path))).toEqual(bytes);
  });

  it('旧版预览沿用现有校验，拒绝加密、宏、类型不符和损坏文件', async () => {
    for (const [source, path] of [
      ['encrypted.doc', 'encrypted.doc'], ['encrypted.xls', 'encrypted.xls'], ['encrypted.ppt', 'encrypted.ppt'],
      ['macros.xls', 'macros.xls'], ['macros.ppt', 'macros.ppt'], ['simple.xls', 'mismatch.doc']
    ]) {
      writeFileSync(join(workspace, path!), readFileSync(new URL(`../fixtures/legacy-office/${source}`, import.meta.url)));
      const response = await server.inject({ url: url(path!), headers });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.json().error.code).toBe('UNSUPPORTED_FILE_TYPE');
    }
    writeFileSync(join(workspace, 'broken.ppt'), Buffer.alloc(100));
    const response = await server.inject({ url: url('broken.ppt'), headers });
    expect(response.json().error.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it.each([false, true])('Word 返回标题、正文与表格结构，原文件保持不变且不能保存为文本（工作区外：%s）', async external => {
    const bytes = createDocx('中文正文 &lt;script&gt;alert(1)&lt;/script&gt;');
    const path = external ? join(directory, "Melissa's 报告.docx") : '报告.docx';
    writeFileSync(external ? path : join(workspace, path), bytes);
    const result = await preview(path);
    expect(result.meta).toMatchObject({ kind: 'office', previewable: true, editable: false });
    expect(result.preview).toMatchObject({ format: 'docx', truncated: false, blocks: [
      { type: 'heading', text: 'Project heading' },
      { type: 'paragraph', text: '中文正文 <script>alert(1)</script>' },
      { type: 'table', rows: [['Name', 'Value'], ['Demo', '10']] }
    ] });
    const thread = await server.inject({ method: 'POST', url: '/threads', headers, payload: {
      projectId, sandbox: 'workspace-write'
    } });
    const saved = await server.inject({ method: 'POST', url: '/workspace/files/content', headers,
      payload: { threadId: thread.json().thread.id, path, content: '不能覆盖', baseVersionToken: result.meta.versionToken } });
    expect(saved.json().error.code).toBe(external ? 'PERMISSION_DENIED' : 'FILE_NOT_EDITABLE');
    expect(readFileSync(external ? path : join(workspace, path))).toEqual(bytes);
  });

  it('Excel 保留工作表顺序、稀疏坐标、零值、布尔值、合并区域和公式缓存', async () => {
    writeFileSync(join(workspace, '数据.xlsx'), await createXlsx());
    const { preview: result } = await preview('数据.xlsx');
    expect(result.format).toBe('xlsx');
    if (result.format !== 'xlsx') return;
    expect(result.sheets.map(sheet => sheet.name)).toEqual(['Summary', 'Details']);
    expect(result.sheets[0]?.merges).toEqual([{ row: 1, column: 1, rowSpan: 1, columnSpan: 2 }]);
    expect(result.sheets[0]?.rows.find(row => row.number === 3)?.cells).toEqual([
      { column: 1, text: '10' }, { column: 3, text: '0' }, { column: 4, text: 'false' },
      { column: 5, text: '20', formula: 'A3*2' },
      { column: 6, text: '无缓存结果', formula: 'SUM(A3:C3)' }
    ]);
    expect(result.sheets[1]?.rows).toEqual([{ number: 7, cells: [{ column: 2, text: 'Detail text' }] }]);
  });

  it('PPT 按 presentation 的真实页序展示内容并关联备注', async () => {
    writeFileSync(join(workspace, '演示.pptx'), createPptx());
    const { preview: result } = await preview('演示.pptx');
    expect(result.format).toBe('pptx');
    if (result.format !== 'pptx') return;
    expect(result.totalSlides).toBe(2);
    expect(JSON.stringify(result.slides[0]?.blocks)).toContain('First displayed slide');
    expect(JSON.stringify(result.slides[1]?.blocks)).toContain('Second displayed slide');
    expect(JSON.stringify(result.slides[0]?.notes)).toContain('Speaker note for first slide');
    expect(result.slides[1]?.notes).toEqual([]);
  });

  it.each([false, true])('PPTX 反斜杠条目可预览正文、页序和备注，下载保留原字节（全部条目：%s）', async all => {
    const parts: Record<string, string | Uint8Array> = {
      ...pptxFiles(), 'docProps/app.xml': '<Properties/>', 'ppt/media/image1.png': new Uint8Array([1, 2, 3])
    };
    const bytes = officeZip(Object.fromEntries(Object.entries(parts).map(([name, content], index) => [
      all || name === 'docProps/app.xml' || index % 2 === 0 ? name.replaceAll('/', '\\') : name, content
    ])));
    const path = '反斜杠演示.pptx';
    writeFileSync(join(workspace, path), bytes);
    const { preview: result } = await preview(path);
    expect(result.format).toBe('pptx');
    if (result.format !== 'pptx') return;
    expect(result.totalSlides).toBe(2);
    expect(JSON.stringify(result.slides[0]?.blocks)).toContain('First displayed slide');
    expect(JSON.stringify(result.slides[1]?.blocks)).toContain('Second displayed slide');
    expect(JSON.stringify(result.slides[0]?.notes)).toContain('Speaker note for first slide');
    expect(result.slides[1]?.notes).toEqual([]);
    expect((await server.inject({ url: url(path, 'download'), headers })).rawPayload).toEqual(bytes);
    expect(readFileSync(join(workspace, path))).toEqual(bytes);
  });

  it('Excel 超出预览行列上限时保留原坐标与工作表状态，并明确标记截断', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('隐藏数据', { state: 'hidden' });
    sheet.getCell('A1').value = '可见内容';
    sheet.getCell('A1001').value = '超出行范围';
    sheet.getCell('CW1').value = '超出列范围';
    writeFileSync(join(workspace, 'large.xlsx'), Buffer.from(await workbook.xlsx.writeBuffer()));
    const { preview: result } = await preview('large.xlsx');
    expect(result.format).toBe('xlsx');
    if (result.format !== 'xlsx') return;
    expect(result.truncated).toBe(true);
    expect(result.sheets[0]).toMatchObject({ name: '隐藏数据', state: 'hidden', totalRows: 1001, totalColumns: 101,
      rowCount: 1000, columnCount: 100, truncated: true, rows: [{ number: 1, cells: [{ column: 1, text: '可见内容' }] }] });
  });

  it('Excel 默认命名空间图表和带前缀表格不阻断单元格预览、提取或原文件下载', async () => {
    const parts: Record<string, string | Uint8Array> = unzipSync(await createXlsx());
    const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
    const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    parts['xl/worksheets/sheet1.xml'] = strFromU8(parts['xl/worksheets/sheet1.xml'] as Uint8Array)
      .replace('</worksheet>', '<drawing r:id="rDrawing"/><tableParts count="1"><tablePart r:id="rTable"/></tableParts></worksheet>');
    parts['xl/worksheets/_rels/sheet1.xml.rels'] = strFromU8(parts['xl/worksheets/_rels/sheet1.xml.rels'] as Uint8Array)
      .replace('</Relationships>', `<Relationship Id="rDrawing" Type="${relNs}/drawing" Target="../drawings/drawing1.xml"/><Relationship Id="rTable" Type="${relNs}/table" Target="../tables/table1.xml"/></Relationships>`);
    parts['xl/drawings/drawing1.xml'] = `<wsDr xmlns="${drawingNs}"><oneCellAnchor><from><col>0</col><colOff>0</colOff><row>10</row><rowOff>0</rowOff></from><ext cx="100000" cy="100000"/><graphicFrame><nvGraphicFramePr><cNvPr id="1" name="Chart 1"/><cNvGraphicFramePr/></nvGraphicFramePr><xfrm/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${relNs}" r:id="rChart"/></a:graphicData></a:graphic></graphicFrame><clientData/></oneCellAnchor></wsDr>`;
    parts['xl/drawings/_rels/drawing1.xml.rels'] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rChart" Type="${relNs}/chart" Target="../charts/chart1.xml"/></Relationships>`;
    parts['xl/charts/chart1.xml'] = '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea/></c:chart></c:chartSpace>';
    parts['xl/tables/table1.xml'] = `<s:table xmlns:s="${sheetNs}" id="1" name="Data" displayName="Data" ref="A3:A3"><s:tableColumns count="1"><s:tableColumn id="1" name="Value"/></s:tableColumns></s:table>`;
    parts['[Content_Types].xml'] = strFromU8(parts['[Content_Types].xml'] as Uint8Array).replace('</Types>',
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
      + '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'
      + '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>');
    const bytes = officeZip(parts);
    writeFileSync(join(workspace, 'chart.xlsx'), bytes);

    const { preview: result } = await preview('chart.xlsx');
    expect(result.format).toBe('xlsx');
    if (result.format !== 'xlsx') return;
    expect(result.sheets.map(sheet => sheet.name)).toEqual(['Summary', 'Details']);
    expect(result.sheets[0]?.merges).toEqual([{ row: 1, column: 1, rowSpan: 1, columnSpan: 2 }]);
    expect(result.sheets[0]?.rows.find(row => row.number === 3)?.cells)
      .toContainEqual({ column: 5, text: '20', formula: 'A3*2' });
    const extracted = await processOfficeAttachment(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'extract');
    expect(extracted.content).toContain('A3*2');
    expect((await server.inject({ url: url('chart.xlsx', 'download'), headers })).rawPayload).toEqual(bytes);
  });

  it('预览沿用鉴权和路径边界，拒绝伪造、损坏及超限文件', async () => {
    writeFileSync(join(workspace, 'broken.docx'), 'not a zip');
    writeFileSync(join(workspace, 'old.doc'), 'legacy');
    writeFileSync(join(workspace, 'large.docx'), Buffer.alloc(20 * 1024 * 1024 + 1));
    expect((await server.inject({ url: url('broken.docx') })).statusCode).toBe(401);
    for (const [path, code] of [
      ['../outside.docx', 'PATH_INVALID'], ['broken.docx', 'UNSUPPORTED_FILE_TYPE'],
      ['old.doc', 'UNSUPPORTED_FILE_TYPE'], ['large.docx', 'FILE_TOO_LARGE']
    ]) {
      const response = await server.inject({ url: url(path!), headers });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.json().error.code).toBe(code);
      expect(response.body).not.toContain(workspace);
    }
  });

  it('超长正文明确标记截断，预览额度不沿用 Agent 的 40000 字符限制', async () => {
    writeFileSync(join(workspace, 'long.docx'), createDocx('大'.repeat(210_000)));
    const { preview: result } = await preview('long.docx');
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeGreaterThan(40_000);
    expect(JSON.stringify(result).length).toBeLessThan(205_000);
  });
});
