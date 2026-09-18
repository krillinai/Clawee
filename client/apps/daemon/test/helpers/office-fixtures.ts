import ExcelJS from 'exceljs';
import { strToU8, zipSync } from 'fflate';

export const OFFICE_MIMES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

export function officeZip(files: Record<string, string | Uint8Array>): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [
    name, typeof content === 'string' ? strToU8(content) : content
  ]))));
}

function packageParts(format: 'docx' | 'pptx', main: string) {
  return {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/${main}" ContentType="${OFFICE_MIMES[format]}.main+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="${main}"/></Relationships>`
  };
}

export function docxFiles(text = 'Clawee document body'): Record<string, string> {
  return {
    ...packageParts('docx', 'word/document.xml'),
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Project heading</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Rose</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`
  };
}

export function createDocx(text?: string): Buffer {
  return officeZip(docxFiles(text));
}

export async function createXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Summary');
  sheet.getCell('A1').value = 'Sales';
  sheet.mergeCells('A1:B1');
  sheet.getCell('A3').value = 10;
  sheet.getCell('C3').value = 0;
  sheet.getCell('D3').value = false;
  sheet.getCell('E3').value = { formula: 'A3*2', result: 20 };
  sheet.getCell('F3').value = { formula: 'SUM(A3:C3)' };
  sheet.getCell('A5').value = new Date('2026-09-18T00:00:00Z');
  sheet.getCell('B5').value = { text: 'External link', hyperlink: 'https://example.invalid/' };
  const second = workbook.addWorksheet('Details');
  second.getCell('B7').value = { richText: [{ text: 'Detail' }, { text: ' text' }] };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function pptxFiles(): Record<string, string> {
  function slide(text: string) {
    return `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${OFFICE_REL}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="1"/><a:gridCol w="1"/></a:tblGrid><a:tr h="1"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Metric</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>42</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`;
  }
  return {
    ...packageParts('pptx', 'ppt/presentation.xml'),
    'ppt/presentation.xml': `<p:presentation xmlns:p="${P}" xmlns:r="${OFFICE_REL}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${OFFICE_REL}/slide" Target="slides/slide2.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': slide('Second displayed slide'),
    'ppt/slides/slide2.xml': slide('First displayed slide'),
    'ppt/slides/_rels/slide2.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId9" Type="${OFFICE_REL}/notesSlide" Target="../notesSlides/notesSlide9.xml"/></Relationships>`,
    'ppt/notesSlides/notesSlide9.xml': `<p:notes xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Speaker note for first slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
  };
}

export function createPptx(): Buffer {
  return officeZip(pptxFiles());
}
