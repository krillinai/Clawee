import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createAttachmentService } from '../../src/attachments/service.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import {
  OFFICE_MIMES, createDocx, createXlsx, createPptx, docxFiles, officeZip
} from '../helpers/office-fixtures.js';

let tempDir = '';
let db: Database.Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-office-attachments-'));
  db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
  return createAttachmentService({ db, dataDir: tempDir });
}

async function extract(format: keyof typeof OFFICE_MIMES, content: Buffer) {
  const service = setup();
  const uploaded = await service.upload({
    draftId: 'draft-office', fileName: `document.${format}`, mime: OFFICE_MIMES[format], content
  });
  const resolved = await service.resolveForRun({
    ids: [uploaded.attachment.id], draftId: 'draft-office'
  });
  expect(resolved.imagePaths).toEqual([]);
  expect((await service.read({ id: uploaded.attachment.id, draftId: 'draft-office' })).content)
    .toEqual(content);
  return resolved.textContext!;
}

describe('Office attachments', () => {
  it('extracts DOCX headings, paragraphs and table rows in document order', async () => {
    const context = await extract('docx', createDocx());
    expect(context).toContain('Project heading');
    expect(context).toContain('Clawee document body');
    expect(context).toContain('Name\tValue');
    expect(context).toContain('Rose\t10');
    expect(context.indexOf('Project heading')).toBeLessThan(context.indexOf('Clawee document body'));
  });

  it('keeps XLSX sheet order, sparse cell addresses, values and cached formulas', async () => {
    const context = await extract('xlsx', await createXlsx());
    expect(context).toContain('工作表：Summary');
    expect(context).toContain('合并区域：A1:B1');
    expect(context).toContain('A3=10');
    expect(context).toContain('C3=0');
    expect(context).toContain('D3=false');
    expect(context).toContain('E3=公式：A3*2；缓存结果：20');
    expect(context).toContain('F3=公式：SUM(A3:C3)；无缓存结果');
    expect(context).toContain('2026-09-18');
    expect(context).toContain('External link');
    expect(context).toContain('B7=Detail text');
    expect(context.indexOf('工作表：Summary')).toBeLessThan(context.indexOf('工作表：Details'));
    expect(context).toContain('不重算公式');
  });

  it('keeps a DOCX list item with multiple text runs on one numbered line', async () => {
    const files = docxFiles();
    files['word/document.xml'] = files['word/document.xml']!.replace('</w:body>',
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
      + '<w:r><w:t xml:space="preserve">List </w:t></w:r><w:r><w:t>item</w:t></w:r></w:p></w:body>');
    const context = await extract('docx', officeZip(files));
    expect(context).toContain('1. List item');
    expect(context).not.toContain('- List');
  });

  it('uses actual PPTX slide order and relationships to attach notes', async () => {
    const context = await extract('pptx', createPptx());
    expect(context).toContain('幻灯片 1');
    expect(context).toContain('Metric\t42');
    expect(context).toContain('演讲备注');
    expect(context.indexOf('First displayed slide')).toBeLessThan(context.indexOf('Second displayed slide'));
    expect(context.indexOf('Speaker note for first slide')).toBeLessThan(context.indexOf('幻灯片 2'));
    expect(context).not.toContain('幻灯片 9');
  });

  it.each(['docx', 'xlsx', 'pptx'] as const)('rejects a generic ZIP disguised as %s', async format => {
    const service = setup();
    await expect(service.upload({
      draftId: 'draft-office', fileName: `fake.${format}`, mime: OFFICE_MIMES[format],
      content: officeZip({ 'readme.txt': 'not an Office document' })
    })).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_MISMATCH', statusCode: 415 });
    expect(service.listStorageFiles()).toEqual([]);
  });

  it('rejects wrong Office types, broken XML, DTDs, macros and oversized expansion', async () => {
    const service = setup();
    const original = docxFiles();
    for (const content of [
      createPptx(),
      officeZip({ ...original, 'word/document.xml': '<broken>' }),
      officeZip({ ...original, 'word/document.xml': '<!DOCTYPE w [<!ENTITY x "test">]><w/>' }),
      officeZip({ ...original, 'word/vbaProject.bin': 'macro' }),
      officeZip({ ...original, 'word/huge.xml': '<w>' + 'a'.repeat(8 * 1024 * 1024) + '</w>' })
    ]) {
      await expect(service.upload({
        draftId: 'draft-office', fileName: 'fake.docx', mime: OFFICE_MIMES.docx, content
      })).rejects.toMatchObject({ statusCode: 415 });
    }
    expect(service.listStorageFiles()).toEqual([]);
  });

  it('rejects encrypted containers and truncated archives with clear errors', async () => {
    const service = setup();
    await expect(service.upload({
      draftId: 'draft-office', fileName: 'encrypted.docx', mime: OFFICE_MIMES.docx,
      content: Buffer.from('d0cf11e0a1b11ae10000000000000000', 'hex')
    })).rejects.toMatchObject({ statusCode: 415, message: expect.stringContaining('加密') });
    await expect(service.upload({
      draftId: 'draft-office', fileName: 'broken.docx', mime: OFFICE_MIMES.docx,
      content: createDocx().subarray(0, 100)
    })).rejects.toMatchObject({ statusCode: 415 });
  });

  it('rejects ZIP entry counts, aggregate expansion, traversal and CRC corruption', async () => {
    const service = setup();
    const original = docxFiles();
    const excessiveEntries = Object.fromEntries(Array.from({ length: 2_050 }, (_, i) => [
      `extra/${i}.txt`, 'entry'
    ]));
    const excessiveExpansion = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [
      `extra/${i}.bin`, 'x'.repeat(7 * 1024 * 1024)
    ]));
    const corrupted = createDocx();
    const centralDirectory = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    corrupted.writeUInt32LE(0, centralDirectory + 16);
    for (const content of [
      officeZip({ ...original, ...excessiveEntries }),
      officeZip({ ...original, ...excessiveExpansion }),
      officeZip({ ...original, '../outside.txt': 'escape' }),
      corrupted
    ]) {
      await expect(service.upload({
        draftId: 'draft-office', fileName: 'unsafe.docx', mime: OFFICE_MIMES.docx, content
      })).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_MISMATCH', statusCode: 415 });
    }
    expect(service.listStorageFiles()).toEqual([]);
  });

  it('bounds Office context and marks omitted document content', async () => {
    const context = await extract('docx', createDocx('a'.repeat(50_000)));
    expect(context.length).toBeLessThan(41_000);
    expect(context).toContain('内容已截断');
    expect(context).toContain('未读取');
    expect(context).not.toContain('a'.repeat(40_001));
  });
});
