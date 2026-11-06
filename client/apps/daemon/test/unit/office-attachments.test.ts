import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import CFB from 'cfb';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { createAttachmentService } from '../../src/attachments/service.js';
import { processOfficeAttachment } from '../../src/attachments/office.js';
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
  expect((await service.read({ id: uploaded.attachment.id, draftId: 'draft-office' })).content.equals(content))
    .toBe(true);
  return resolved.textContext!;
}

describe('Office attachments', () => {
  const fixture = (name: string) => readFileSync(new URL(`../fixtures/legacy-office/${name}`, import.meta.url));

  it.each([
    ['doc', 'This is a simple file created with Word 97-SR2.'],
    ['xls', 'replaceMe'],
    ['ppt', 'This is a test title']
  ] as const)('uploads and extracts genuine legacy %s files', async (format, text) => {
    const context = await extract(format, fixture(`simple.${format}`));
    expect(context).toContain(text);
    if (format === 'xls') {
      expect(context.indexOf('Sheet1')).toBeLessThan(context.indexOf('Sheet2'));
    }
    if (format === 'ppt') {
      expect(context.indexOf('This is a test title')).toBeLessThan(context.indexOf('This is page two'));
    }
  });

  it.each(['doc', 'xls', 'ppt'] as const)('rejects fake, mismatched and truncated legacy %s files', async format => {
    const service = setup();
    for (const content of [
      Buffer.from('not an Office document'),
      createDocx(),
      fixture(format === 'doc' ? 'simple.xls' : 'simple.doc'),
      fixture(`simple.${format}`).subarray(0, 100)
    ]) {
      await expect(service.upload({
        draftId: 'draft-office', fileName: `fake.${format}`, mime: OFFICE_MIMES[format], content
      })).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_MISMATCH', statusCode: 415 });
    }
    expect(service.listStorageFiles()).toEqual([]);
  });

  it('rejects encrypted and macro-enabled legacy Office files', async () => {
    const service = setup();
    for (const [name, format, message] of [
      ['encrypted.doc', 'doc', '加密'], ['encrypted.xls', 'xls', '加密'],
      ['encrypted.ppt', 'ppt', '加密'], ['macros.xls', 'xls', '宏'], ['macros.ppt', 'ppt', '宏']
    ] as const) {
      await expect(service.upload({
        draftId: 'draft-office', fileName: name, mime: OFFICE_MIMES[format], content: fixture(name)
      })).rejects.toMatchObject({ statusCode: 415, message: expect.stringContaining(message) });
    }
    expect(service.listStorageFiles()).toEqual([]);
  });

  it('rejects macros embedded in legacy Word files', async () => {
    const content = CFB.read(fixture('simple.doc'), { type: 'buffer' });
    CFB.utils.cfb_add(content, 'Macros/VBA/Module1', Buffer.from('macro'));
    const service = setup();
    await expect(service.upload({
      draftId: 'draft-office', fileName: 'macros.doc', mime: OFFICE_MIMES.doc,
      content: Buffer.from(CFB.write(content, { type: 'buffer' }))
    })).rejects.toMatchObject({ statusCode: 415, message: expect.stringContaining('宏') });
  });

  it('bounds legacy document context and marks omitted content', async () => {
    const result = await processOfficeAttachment(fixture('simple.doc'), OFFICE_MIMES.doc, 'extract', 24);
    expect(result.content).toHaveLength(24);
    expect(result.content).toContain('This is a simple');
    expect(result.detail).toContain('内容已截断');
  });

  it.each(['doc', 'xls', 'ppt'] as const)('accepts large binary streams in legacy %s within the upload limit', async format => {
    const container = CFB.read(fixture(`simple.${format}`), { type: 'buffer' });
    CFB.utils.cfb_add(container, 'ExtraData', Buffer.alloc(34 * 1024 * 1024));
    const context = await extract(format, Buffer.from(CFB.write(container, { type: 'buffer' })));
    expect(context).toContain(format === 'doc' ? 'This is a simple file'
      : format === 'xls' ? 'replaceMe' : 'This is a test title');
  });

  it('accepts large OOXML binary parts while keeping the document readable', async () => {
    const content = officeZip({ ...docxFiles(), 'extra/large.bin': randomBytes(12 * 1024 * 1024) });
    const context = await extract('docx', content);
    expect(context).toContain('Clawee document body');
  });

  it('accepts large XLSX worksheet XML within the per-entry limit', async () => {
    const service = setup();
    const files = unzipSync(await createXlsx());
    files['xl/worksheets/sheet1.xml'] = strToU8(
      `${strFromU8(files['xl/worksheets/sheet1.xml']!)}<!--${'a'.repeat(12 * 1024 * 1024)}-->`
    );
    const content = officeZip(files);
    await expect(service.upload({
      draftId: 'draft-office', fileName: 'large.xlsx', mime: OFFICE_MIMES.xlsx, content
    })).resolves.toMatchObject({ attachment: { fileName: 'large.xlsx' } });
  });

  it('extracts DOCX headings, paragraphs and table rows in document order', async () => {
    const context = await extract('docx', createDocx());
    expect(context).toContain('Project heading');
    expect(context).toContain('Clawee document body');
    expect(context).toContain('Name\tValue');
    expect(context).toContain('Demo\t10');
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

  it.each([
    ['docx', 'word/document.xml'], ['xlsx', 'xl/workbook.xml'], ['pptx', 'ppt/presentation.xml']
  ] as const)('%s 主文档支持 Default 类型声明，并保留上传原字节', async (format, main) => {
    const original = format === 'docx' ? createDocx() : format === 'xlsx' ? await createXlsx() : createPptx();
    const files = unzipSync(original);
    const type = `${OFFICE_MIMES[format]}.main+xml`;
    files['[Content_Types].xml'] = strToU8(strFromU8(files['[Content_Types].xml']!)
      .replace('<Default Extension="xml" ContentType="application/xml"/>', '')
      .replace(`<Override PartName="/${main}" ContentType="${type}"/>`,
        `<Default Extension="xml" ContentType="${type}"/>`));
    const expected = await processOfficeAttachment(original, OFFICE_MIMES[format], 'extract');
    expect(await extract(format, officeZip(files))).toContain(expected.content);
  });

  it.each([
    ['错误的默认类型', 'application/xml', undefined, 'xml'],
    ['错误的覆盖类型', `${OFFICE_MIMES.xlsx}.main+xml`, `${OFFICE_MIMES.docx}.main+xml`, 'xml'],
    ['空的覆盖类型', `${OFFICE_MIMES.xlsx}.main+xml`, '', 'xml'],
    ['不匹配的扩展名', `${OFFICE_MIMES.xlsx}.main+xml`, undefined, 'bin']
  ] as const)('Default 兼容仍拒绝%s', async (_label, defaultType, overrideType, extension) => {
    const files = unzipSync(await createXlsx());
    files['[Content_Types].xml'] = strToU8(strFromU8(files['[Content_Types].xml']!)
      .replace('<Default Extension="xml" ContentType="application/xml"/>', '')
      .replace(`<Override PartName="/xl/workbook.xml" ContentType="${OFFICE_MIMES.xlsx}.main+xml"/>`,
        `<Default Extension="${extension}" ContentType="${defaultType}"/>`
        + (overrideType === undefined ? '' : `<Override PartName="/xl/workbook.xml" ContentType="${overrideType}"/>`)));
    await expect(processOfficeAttachment(officeZip(files), OFFICE_MIMES.xlsx, 'validate'))
      .rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_MISMATCH', message: 'Office 附件实际格式与声明类型不符' });
  });

  it.each(['x', 'spreadsheet'])('XLSX 兼容 %s 命名空间前缀，保留提取、预览与原字节', async prefix => {
    const files = unzipSync(await createXlsx());
    files['xl/sharedStrings.xml'] = strToU8(strFromU8(files['xl/sharedStrings.xml']!)
      .replace('Sales', 'literal x:worksheet &amp; &lt;x:sst&gt;'));
    const original = officeZip(files);
    const expected = await processOfficeAttachment(original, OFFICE_MIMES.xlsx, 'extract');
    const expectedPreview = await processOfficeAttachment(original, OFFICE_MIMES.xlsx, 'preview');
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.startsWith('xl/') || !name.endsWith('.xml')) continue;
      const xml = strFromU8(bytes);
      const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
      if (!xml.includes(`xmlns="${namespace}"`)) continue;
      files[name] = strToU8(xml.replace(/<(\/?)([\w.-]+)(?=[\s/>])/g, `<$1${prefix}:$2`)
        .replace(`xmlns="${namespace}"`, `xmlns:${prefix}="${namespace}"`));
    }
    const content = officeZip(files);
    const context = await extract('xlsx', content);
    expect(context).toContain(expected.content);
    expect(context).toContain('literal x:worksheet & <x:sst>');
    expect((await processOfficeAttachment(content, OFFICE_MIMES.xlsx, 'preview')).preview)
      .toEqual(expectedPreview.preview);
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

  it.each([
    ['docx', 'Clawee document body'], ['xlsx', 'B7=Detail text'], ['pptx', 'First displayed slide']
  ] as const)('兼容 %s 压缩包的反斜杠条目，并保留上传原字节', async (format, text) => {
    const original = format === 'docx' ? createDocx() : format === 'xlsx' ? await createXlsx() : createPptx();
    const content = officeZip(Object.fromEntries(Object.entries(unzipSync(original)).map(([name, bytes]) => [
      name.replaceAll('/', '\\'), bytes
    ])));
    expect(await extract(format, content)).toContain(text);
  });

  it.each([
    ['word\\document.xml', '<document/>', '重复'],
    ['extra\\..\\outside.txt', 'escape', 'invalid relative path'],
    ['extra\\.\\outside.txt', 'escape', '不安全的条目路径'],
    ['\\outside.txt', 'escape', 'absolute path'],
    ['C:\\outside.txt', 'escape', 'absolute path'],
    ['word\\vbaProject.bin', 'macro', '宏'],
    ['word\\broken.xml', '<broken>', '损坏的 XML'],
    ['word\\entity.xml', '<!DOCTYPE w [<!ENTITY x "test">]><w/>', 'DTD']
  ] as const)('反斜杠兼容仍拒绝重名、不安全路径、宏和损坏 XML：%s', async (name, bytes, message) => {
    const content = officeZip({ ...docxFiles(), [name]: bytes });
    await expect(processOfficeAttachment(content, OFFICE_MIMES.docx, 'preview'))
      .rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED', message: expect.stringContaining(message) });
  });

  it('反斜杠兼容仍校验 CRC 且不放宽 XML 内部关系路径', async () => {
    const files = Object.fromEntries(Object.entries(docxFiles()).map(([name, text]) => [
      name.replaceAll('/', '\\'), text
    ]));
    const corrupted = officeZip(files);
    const centralDirectory = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    corrupted.writeUInt32LE(0, centralDirectory + 16);
    await expect(processOfficeAttachment(corrupted, OFFICE_MIMES.docx, 'preview'))
      .rejects.toMatchObject({ message: expect.stringContaining('压缩内容损坏') });

    files['_rels\\.rels'] = files['_rels\\.rels']!.replace('word/document.xml', 'word\\document.xml');
    await expect(processOfficeAttachment(officeZip(files), OFFICE_MIMES.docx, 'preview'))
      .rejects.toMatchObject({ message: expect.stringContaining('不安全的内部关系') });
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
      officeZip({ ...original, 'word/huge.xml': '<w>' + 'a'.repeat(64 * 1024 * 1024) + '</w>' })
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
    const excessiveExpansion = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [
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
