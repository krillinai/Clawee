import { parentPort, workerData } from 'node:worker_threads';
import { posix } from 'node:path';
import { crc32 } from 'node:zlib';
import { fromBufferPromise, getFileNameLowLevel, type Entry } from 'yauzl';
import { zipSync } from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import CFB from 'cfb';
import type { Document } from '@xmldom/xmldom';
import type { OfficeContentNode } from 'officeparser';
import { ATTACHMENT_MAX_SIZE_BYTES } from '@clawee/protocol';
import type { OfficeExtraction, OfficeWorkerRequest } from './office.js';

const MAX_ENTRIES = 2_048;
const MAX_XML_BYTES = 64 * 1024 * 1024;
const MAX_XML_DOM_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * ATTACHMENT_MAX_SIZE_BYTES;
const MAIN_PARTS = {
  docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml'
};
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

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

function normalizeWorkbookXml(document: Document): Buffer {
  // ExcelJS 按标签全名匹配；只规范化表格命名空间中的元素，保留属性与文本。
  for (const element of Array.from(document.getElementsByTagNameNS(SPREADSHEET_NS, '*'))) {
    if (!element.prefix) continue;
    const replacement = document.createElementNS(SPREADSHEET_NS, element.localName!);
    for (const attribute of Array.from(element.attributes)) {
      // 默认命名空间由序列化器按元素的实际命名空间补全。
      if (attribute.name !== 'xmlns') {
        replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
      }
    }
    while (element.firstChild) replacement.appendChild(element.firstChild);
    element.parentNode!.replaceChild(replacement, element);
  }
  return Buffer.from(new XMLSerializer().serializeToString(document));
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

async function validatePackage(content: Buffer, format: keyof typeof MAIN_PARTS, mime: string) {
  if (content.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
    invalid('不支持加密 Office 附件，请先解密后上传');
  }
  const zip = await fromBufferPromise(content, {
    strictFileNames: false, validateEntrySizes: true, autoClose: false
  });
  const names = new Set<string>();
  const manifests = new Map<string, Document>();
  const workbookParts = new Map<string, Document>();
  const entries: Entry[] = [];
  const normalizedFiles: Record<string, Uint8Array> = Object.create(null);
  let normalizeNames = false;
  let declaredBytes = 0;
  let actualBytes = 0;
  try {
    if (zip.entryCount > MAX_ENTRIES) invalid('Office 附件包含过多压缩条目');
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      // yauzl 将反斜杠转换为正斜杠，并继续拒绝绝对路径与越界路径。
      normalizeNames ||= getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, true) !== name;
      if (names.has(name) || names.size >= MAX_ENTRIES) invalid('Office 附件包含重复或过多条目');
      names.add(name);
      if (entry.isEncrypted()) invalid('不支持加密 Office 附件，请先解密后上传');
      if (name.split('/').some(part => part === '..' || part === '.') || name.includes('\0')) {
        invalid('Office 附件包含不安全的条目路径');
      }
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) invalid('Office 附件包含特殊文件');
      if (/vbaProject\.bin$/i.test(name)) invalid('不支持包含宏的 Office 附件');
      const xml = name.endsWith('.xml') || name.endsWith('.rels');
      const entryLimit = xml ? MAX_XML_BYTES : ATTACHMENT_MAX_SIZE_BYTES;
      if (entry.uncompressedSize > entryLimit) invalid('Office 附件解压后的单项内容过大');
      declaredBytes += entry.uncompressedSize;
      if (declaredBytes > MAX_EXPANDED_BYTES) invalid('Office 附件解压后的总量过大');
      entries.push(entry);
    }
    for (const entry of entries) {
      const name = entry.fileName;
      if (name.endsWith('/')) continue;
      const xml = name.endsWith('.xml') || name.endsWith('.rels');
      const entryLimit = xml ? MAX_XML_BYTES : ATTACHMENT_MAX_SIZE_BYTES;
      // 大型 XLSX 工作表由 ExcelJS 后续解析，避免 xmldom 为单个 sheet 建立超大 DOM。
      const parseXmlEntry = xml && !(
        format === 'xlsx'
        && name.startsWith('xl/worksheets/')
        && !name.endsWith('.rels')
        && entry.uncompressedSize > MAX_XML_DOM_BYTES
      );
      const chunks: Buffer[] = [];
      const stream = await zip.openReadStreamPromise(entry);
      let bytes = 0;
      let checksum = 0;
      for await (const chunk of stream) {
        const buffer = chunk as Buffer;
        bytes += buffer.length;
        actualBytes += buffer.length;
        if (bytes > entryLimit || actualBytes > MAX_EXPANDED_BYTES) {
          stream.destroy();
          invalid('Office 附件解压后的内容过大');
        }
        checksum = crc32(buffer, checksum);
        if (parseXmlEntry || normalizeNames) chunks.push(buffer);
      }
      if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) invalid('Office 附件压缩内容损坏');
      const entryContent = parseXmlEntry || normalizeNames ? Buffer.concat(chunks) : undefined;
      if (normalizeNames) normalizedFiles[name] = entryContent!;
      if (parseXmlEntry) {
        const document = parseXml(new TextDecoder('utf-8', { fatal: true }).decode(entryContent));
        const expectedRoot = name === 'word/document.xml' ? 'document'
          : name === 'xl/workbook.xml' ? 'workbook'
            : name === 'ppt/presentation.xml' ? 'presentation'
              : /^ppt\/slides\/slide\d+\.xml$/.test(name) ? 'sld'
                : /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name) ? 'notes' : undefined;
        if (expectedRoot !== undefined && document.documentElement?.localName !== expectedRoot) {
          invalid('Office 附件文档结构损坏');
        }
        if (name === '[Content_Types].xml' || name === '_rels/.rels'
          || name === MAIN_PARTS[format] || name.startsWith('ppt/') && name.endsWith('.rels')) {
          manifests.set(name, document);
        }
        if (format === 'xlsx' && name.startsWith('xl/') && !/^xl\/(?:drawings|tables)\//.test(name)
          && Array.from(document.getElementsByTagNameNS(SPREADSHEET_NS, '*')).some(node => node.prefix)) {
          workbookParts.set(name, document);
        }
      }
    }
  } finally {
    zip.close();
  }
  const main = MAIN_PARTS[format];
  const types = manifests.get('[Content_Types].xml');
  const rootRels = manifests.get('_rels/.rels');
  if (types === undefined || rootRels === undefined || !manifests.has(main)) {
    invalid('Office 附件缺少必要的文档结构');
  }
  const declaredType = elements(types, 'Override').find(node => node.getAttribute('PartName') === `/${main}`)
    ?? elements(types, 'Default').find(node => node.getAttribute('Extension') === posix.extname(main).slice(1));
  if (declaredType?.getAttribute('ContentType') !== `${mime}.main+xml`) {
    invalid('Office 附件实际格式与声明类型不符');
  }
  const root = elements(rootRels, 'Relationship').find(node => node.getAttribute('Type') === `${OFFICE_REL}/officeDocument`);
  if (root === undefined || root.getAttribute('TargetMode') === 'External'
    || relationshipTarget('', root.getAttribute('Target') ?? '') !== main) {
    invalid('Office 附件缺少有效的主文档关系');
  }
  // 后续解析器也需要规范的 ZIP 路径；只在内存中生成副本，不改写原文件。
  return { manifests, names, workbookParts, content: normalizeNames ? Buffer.from(zipSync(normalizedFiles, { level: 0 })) : content };
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
  await workbook.xlsx.load(Uint8Array.from(content).buffer, { ignoreNodes: ['drawing', 'tableParts'] });
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

function* presentationSlides(
  nodes: OfficeContentNode[], manifests: Map<string, Document>, names: Set<string>
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
    const rId = id.getAttributeNS(OFFICE_REL, 'id');
    const relationship = rels.find(rel => rel.getAttribute('Id') === rId && rel.getAttribute('Type') === `${OFFICE_REL}/slide`);
    if (relationship === undefined || relationship.getAttribute('TargetMode') === 'External') invalid('PPTX 幻灯片关系无效');
    const target = relationshipTarget(source, relationship.getAttribute('Target') ?? '');
    const number = target.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1];
    if (number === undefined || !names.has(target)) invalid('PPTX 幻灯片缺失或名称不受支持');
    const slide = slides.find(node => node.type === 'slide' && node.metadata?.slideNumber === Number(number));
    let noteNodes: OfficeContentNode[] = [];
    const slideRels = manifests.get(posix.join(posix.dirname(target), '_rels', posix.basename(target) + '.rels'));
    const noteRel = slideRels === undefined ? undefined : elements(slideRels, 'Relationship')
      .find(rel => rel.getAttribute('Type') === `${OFFICE_REL}/notesSlide`);
    if (noteRel !== undefined) {
      if (noteRel.getAttribute('TargetMode') === 'External') invalid('PPTX 备注关系无效');
      const noteTarget = relationshipTarget(target, noteRel.getAttribute('Target') ?? '');
      const noteNumber = noteTarget.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/)?.[1];
      if (!names.has(noteTarget) || noteNumber === undefined) invalid('PPTX 演讲备注无法读取');
      noteNodes = notes.get(Number(noteNumber)) ?? [];
    }
    yield { number: index + 1, children: slide?.children ?? [], notes: noteNodes, hasNotes: noteRel !== undefined };
  }
}

async function processDocument(request: OfficeWorkerRequest): Promise<OfficeExtraction> {
  const originalContent = Buffer.from(request.content);
  if (request.format === 'doc' || request.format === 'xls' || request.format === 'ppt') {
    const { processLegacyOfficeAttachment } = await import(new URL(
      import.meta.url.endsWith('.ts') ? './legacy-office.ts' : './legacy-office.js', import.meta.url
    ).href) as typeof import('./legacy-office.js');
    return processLegacyOfficeAttachment(originalContent, request.format, request.mode, request.maxChars);
  }
  const { manifests, names, workbookParts, content } = await validatePackage(originalContent, request.format, request.mime);
  if (request.mode === 'validate') return { content: '' };
  const previewModule = request.mode === 'preview' ? await import(new URL(
    import.meta.url.endsWith('.ts') ? './office-preview.ts' : './office-preview.js', import.meta.url
  ).href) as typeof import('./office-preview.js') : undefined;
  if (request.format === 'xlsx') {
    // 内容预览只读取单元格，不展示绘图或结构化表格的筛选样式。
    // 在已验证的副本中移除这些元数据，并规范化 XML 元素前缀，供 ExcelJS 读取。
    let cellContent = content;
    if (workbookParts.size > 0 || Array.from(names).some(name => /^xl\/(?:drawings|tables)\//.test(name))) {
      const container = CFB.read(content, { type: 'buffer' });
      for (const path of [...container.FullPaths]) {
        if (/^Root Entry\/xl\/(?:drawings|tables)\//.test(path)) CFB.utils.cfb_del(container, path);
      }
      for (const [name, document] of workbookParts) {
        CFB.utils.cfb_add(container, name, normalizeWorkbookXml(document));
      }
      cellContent = Buffer.from(CFB.write(container, { type: 'buffer', fileType: 'zip' }));
    }
    return previewModule
      ? { content: '', preview: await previewModule.previewWorkbook(cellContent) }
      : extractWorkbook(cellContent, request.maxChars);
  }
  const { parseOffice } = await import('officeparser');
  const ast = await parseOffice(content, {
    fileType: request.format,
    ocr: false, extractAttachments: false, includeRawContent: false,
    ignoreNotes: false, ignoreComments: true, ignoreSlideMasters: true,
    decompressionLimits: { maxZipEntries: MAX_ENTRIES, maxUncompressedBytes: MAX_EXPANDED_BYTES },
    onWarning: () => undefined
  });
  const sink = textSink(request.maxChars);
  if (request.format === 'pptx') {
    const slides = presentationSlides(ast.content, manifests, names);
    const totalSlides = elements(manifests.get('ppt/presentation.xml')!, 'sldId').length;
    if (previewModule) return { content: '', preview: previewModule.previewPresentation(slides, totalSlides) };
    for (const slide of slides) {
      if (sink.full) break;
      const location = `幻灯片 ${slide.number}`;
      sink.append(`--- ${location} ---`, location);
      renderNodes(slide.children, sink, location);
      if (slide.hasNotes) {
        sink.append('[演讲备注]', location);
        renderNodes(slide.notes, sink, location + '演讲备注');
      }
    }
    return sink.result(`${totalSlides} 张幻灯片`);
  }
  if (previewModule) return { content: '', preview: previewModule.previewDocument(ast.content) };
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
