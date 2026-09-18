import { parentPort, workerData } from 'node:worker_threads';
import { posix } from 'node:path';
import { crc32 } from 'node:zlib';
import { fromBufferPromise } from 'yauzl';
import { DOMParser } from '@xmldom/xmldom';
import type { Document } from '@xmldom/xmldom';
import type { OfficeContentNode } from 'officeparser';
import type { OfficeExtraction, OfficeWorkerRequest } from './office.js';

const MAX_ENTRIES = 2_048;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAIN_PARTS = {
  docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml'
};
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function invalid(message: string): never {
  throw new Error(message);
}

function parseXml(text: string): Document {
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text)) invalid('Office 附件包含不支持的 DTD 或实体声明');
  return new DOMParser({ onError: () => invalid('Office 附件包含损坏的 XML') })
    .parseFromString(text, 'application/xml');
}

function elements(document: Document, name: string) {
  return Array.from(document.getElementsByTagNameNS('*', name));
}

function relationshipTarget(source: string, target: string): string {
  if (!target || target.includes('\\') || /[?#%]/.test(target) || /^[a-z]+:/i.test(target)) {
    invalid('Office 附件包含不安全的内部关系');
  }
  const path = target.startsWith('/')
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join(posix.dirname(source), target));
  if (path.startsWith('../') || path === '..') invalid('Office 附件内部关系越界');
  return path;
}

async function validatePackage(content: Buffer, request: OfficeWorkerRequest) {
  if (content.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
    invalid('不支持加密 Office 附件，请先解密后上传');
  }
  const zip = await fromBufferPromise(content, {
    strictFileNames: true, validateEntrySizes: true, autoClose: false
  });
  const names = new Set<string>();
  const manifests = new Map<string, Document>();
  let declaredBytes = 0;
  let actualBytes = 0;
  try {
    if (zip.entryCount > MAX_ENTRIES) invalid('Office 附件包含过多压缩条目');
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (names.has(name) || names.size >= MAX_ENTRIES) invalid('Office 附件包含重复或过多条目');
      names.add(name);
      if (entry.isEncrypted()) invalid('不支持加密 Office 附件，请先解密后上传');
      if (name.split('/').some(part => part === '..' || part === '.') || name.includes('\0')) {
        invalid('Office 附件包含不安全的条目路径');
      }
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) invalid('Office 附件包含特殊文件');
      if (/vbaProject\.bin$/i.test(name)) invalid('不支持包含宏的 Office 附件');
      if (entry.uncompressedSize > MAX_FILE_BYTES) invalid('Office 附件解压后的单项内容过大');
      declaredBytes += entry.uncompressedSize;
      if (declaredBytes > MAX_EXPANDED_BYTES) invalid('Office 附件解压后的总量过大');
      if (name.endsWith('/')) continue;
      const xml = name.endsWith('.xml') || name.endsWith('.rels');
      const chunks: Buffer[] = [];
      const stream = await zip.openReadStreamPromise(entry);
      let bytes = 0;
      let checksum = 0;
      for await (const chunk of stream) {
        const buffer = chunk as Buffer;
        bytes += buffer.length;
        actualBytes += buffer.length;
        if (bytes > MAX_FILE_BYTES || actualBytes > MAX_EXPANDED_BYTES) {
          stream.destroy();
          invalid('Office 附件解压后的内容过大');
        }
        checksum = crc32(buffer, checksum);
        if (xml) chunks.push(buffer);
      }
      if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) invalid('Office 附件压缩内容损坏');
      if (xml) {
        const document = parseXml(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        const expectedRoot = name === 'word/document.xml' ? 'document'
          : name === 'xl/workbook.xml' ? 'workbook'
            : name === 'ppt/presentation.xml' ? 'presentation'
              : /^ppt\/slides\/slide\d+\.xml$/.test(name) ? 'sld'
                : /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name) ? 'notes' : undefined;
        if (expectedRoot !== undefined && document.documentElement?.localName !== expectedRoot) {
          invalid('Office 附件文档结构损坏');
        }
        if (name === '[Content_Types].xml' || name === '_rels/.rels'
          || name === MAIN_PARTS[request.format] || name.startsWith('ppt/') && name.endsWith('.rels')) {
          manifests.set(name, document);
        }
      }
    }
  } finally {
    zip.close();
  }
  const main = MAIN_PARTS[request.format];
  const types = manifests.get('[Content_Types].xml');
  const rootRels = manifests.get('_rels/.rels');
  if (types === undefined || rootRels === undefined || !manifests.has(main)) {
    invalid('Office 附件缺少必要的文档结构');
  }
  const declaredType = elements(types, 'Override').find(node => node.getAttribute('PartName') === `/${main}`);
  if (declaredType?.getAttribute('ContentType') !== `${request.mime}.main+xml`) {
    invalid('Office 附件实际格式与声明类型不符');
  }
  const root = elements(rootRels, 'Relationship').find(node => node.getAttribute('Type') === `${OFFICE_REL}/officeDocument`);
  if (root === undefined || root.getAttribute('TargetMode') === 'External'
    || relationshipTarget('', root.getAttribute('Target') ?? '') !== main) {
    invalid('Office 附件缺少有效的主文档关系');
  }
  return { manifests, names };
}

function textSink(maxChars: number) {
  const lines: string[] = [];
  let chars = 0;
  let omitted: string | undefined;
  return {
    get full() { return omitted !== undefined; },
    append(text: string, location: string) {
      if (omitted !== undefined) return;
      text = text.trim();
      if (!text) return;
      if (chars + text.length + 1 > maxChars) {
        omitted = location;
        return;
      }
      lines.push(text);
      chars += text.length + 1;
    },
    result(detail: string): OfficeExtraction {
      return {
        content: lines.join('\n') || (omitted === undefined && maxChars > 0 ? '[无可提取文字]' : ''),
        detail: `${detail}${omitted === undefined ? '' : `；内容已截断（从${omitted}开始及其后内容未读取）`}`
      };
    }
  };
}

type TextSink = ReturnType<typeof textSink>;

function renderNodes(nodes: OfficeContentNode[], sink: TextSink, location: string) {
  for (const [index, node] of nodes.entries()) {
    if (sink.full) break;
    const position = `${location}第 ${index + 1} 个内容块`;
    if (node.type === 'table') {
      sink.append('[表格]', position);
      for (const [rowIndex, row] of (node.children ?? []).entries()) {
        sink.append((row.children ?? []).map(cell => cell.text ?? '').join('\t'), `${position}表格第 ${rowIndex + 1} 行`);
        if (sink.full) break;
      }
    } else if (node.type === 'heading') {
      sink.append(`${'#'.repeat(Math.min(6, node.metadata?.level ?? 1))} ${node.text ?? ''}`, position);
    } else if (node.type === 'list') {
      const marker = node.metadata?.listType === 'ordered'
        ? `${(node.metadata.itemIndex ?? 0) + 1}.` : '-';
      sink.append(`${marker} ${node.text ?? ''}`, position);
    } else if (node.type === 'image' || node.type === 'chart' || node.type === 'drawing') {
      sink.append('[图片或图表未解析]', position);
    } else if (node.text) sink.append(node.text, position);
    else if (node.children) renderNodes(node.children, sink, position);
    for (const note of node.notes ?? []) sink.append(`[注释] ${note.text ?? ''}`, position);
  }
}

async function extractWorkbook(content: Buffer, maxChars: number) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(content).buffer);
  const sink = textSink(maxChars);
  sink.append('工作表目录：' + workbook.worksheets.map(sheet => sheet.name).join('、'), '工作表目录');
  sink.append('公式使用已有缓存结果，可能过期；不重算公式。', '公式说明');
  for (const sheet of workbook.worksheets) {
    if (sink.full) break;
    sink.append(`工作表：${sheet.name}（${sheet.state}）`, `工作表 ${sheet.name}`);
    if (sheet.model.merges.length > 0) {
      sink.append(`合并区域：${sheet.model.merges.join('、')}`, `工作表 ${sheet.name}合并区域`);
    }
    sheet.eachRow((row, rowNumber) => {
      if (sink.full) return;
      const cells: string[] = [];
      row.eachCell(cell => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        let value = cell.value instanceof Date ? cell.value.toISOString() : cell.text;
        if (cell.formula) {
          const result = cell.result;
          const cached = result === undefined || result === null ? '无缓存结果'
            : `缓存结果：${typeof result === 'object' && 'error' in result ? result.error : String(result)}`;
          value = `公式：${cell.formula}；${cached}`;
        }
        cells.push(`${cell.address}=${value}`);
      });
      sink.append(`第 ${rowNumber} 行：${cells.join('\t')}`, `工作表 ${sheet.name}第 ${rowNumber} 行`);
    });
  }
  return sink.result(`${workbook.worksheets.length} 个工作表`);
}

function renderPresentation(
  nodes: OfficeContentNode[], manifests: Map<string, Document>, names: Set<string>, sink: TextSink
) {
  const source = 'ppt/presentation.xml';
  const relationships = manifests.get('ppt/_rels/presentation.xml.rels');
  if (relationships === undefined) invalid('PPTX 缺少幻灯片关系');
  const rels = elements(relationships, 'Relationship');
  const slides = nodes.filter(node => node.type === 'slide');
  // 解析库按文件编号输出，必须根据 presentation 的关系重排，并重新关联备注。
  const notes = new Map<number, OfficeContentNode[]>();
  for (const slide of slides) {
    if (slide.type === 'slide' && slide.metadata?.slideNumber !== undefined && slide.notes) {
      notes.set(slide.metadata.slideNumber, slide.notes.flatMap(note => note.children ?? []));
    }
  }
  const slideIds = elements(manifests.get(source)!, 'sldId');
  for (const [index, id] of slideIds.entries()) {
    if (sink.full) break;
    const rId = id.getAttributeNS(OFFICE_REL, 'id');
    const relationship = rels.find(rel => rel.getAttribute('Id') === rId && rel.getAttribute('Type') === `${OFFICE_REL}/slide`);
    if (relationship === undefined || relationship.getAttribute('TargetMode') === 'External') invalid('PPTX 幻灯片关系无效');
    const target = relationshipTarget(source, relationship.getAttribute('Target') ?? '');
    const number = target.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1];
    if (number === undefined || !names.has(target)) invalid('PPTX 幻灯片缺失或名称不受支持');
    const slide = slides.find(node => node.type === 'slide' && node.metadata?.slideNumber === Number(number));
    const location = `幻灯片 ${index + 1}`;
    sink.append(`--- ${location} ---`, location);
    renderNodes(slide?.children ?? [], sink, location);
    const slideRels = manifests.get(posix.join(posix.dirname(target), '_rels', posix.basename(target) + '.rels'));
    const noteRel = slideRels === undefined ? undefined : elements(slideRels, 'Relationship')
      .find(rel => rel.getAttribute('Type') === `${OFFICE_REL}/notesSlide`);
    if (noteRel !== undefined) {
      if (noteRel.getAttribute('TargetMode') === 'External') invalid('PPTX 备注关系无效');
      const noteTarget = relationshipTarget(target, noteRel.getAttribute('Target') ?? '');
      const noteNumber = noteTarget.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/)?.[1];
      if (!names.has(noteTarget) || noteNumber === undefined) invalid('PPTX 演讲备注无法读取');
      const noteNodes = notes.get(Number(noteNumber)) ?? [];
      sink.append('[演讲备注]', location);
      renderNodes(noteNodes, sink, location + '演讲备注');
    }
  }
  return sink.result(`${slideIds.length} 张幻灯片`);
}

async function processDocument(request: OfficeWorkerRequest): Promise<OfficeExtraction> {
  const content = Buffer.from(request.content);
  const { manifests, names } = await validatePackage(content, request);
  if (request.mode === 'validate') return { content: '' };
  if (request.format === 'xlsx') return extractWorkbook(content, request.maxChars);
  const { parseOffice } = await import('officeparser');
  const ast = await parseOffice(content, {
    fileType: request.format,
    ocr: false, extractAttachments: false, includeRawContent: false,
    ignoreNotes: false, ignoreComments: true, ignoreSlideMasters: true,
    decompressionLimits: { maxZipEntries: MAX_ENTRIES, maxUncompressedBytes: MAX_EXPANDED_BYTES },
    onWarning: () => undefined
  });
  const sink = textSink(request.maxChars);
  if (request.format === 'pptx') return renderPresentation(ast.content, manifests, names, sink);
  renderNodes(ast.content, sink, '文档');
  return sink.result('正文及表格；未读取图片内容');
}

processDocument(workerData as OfficeWorkerRequest).then(result => parentPort?.postMessage(result))
  .catch((error: unknown) => parentPort?.postMessage({
    error: {
      code: (workerData as OfficeWorkerRequest).mode === 'validate'
        ? 'ATTACHMENT_TYPE_MISMATCH' : 'ATTACHMENT_TYPE_UNSUPPORTED',
      message: error instanceof Error ? error.message : 'Office 附件无法读取'
    }
  }));
