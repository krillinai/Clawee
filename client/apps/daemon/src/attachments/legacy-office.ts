import { readFileSync } from 'node:fs';
import CFB from 'cfb';
import { initSync, WasmDocument } from 'office-oxide-wasm/web';
import type { OfficeExtraction, OfficeWorkerRequest } from './office.js';

type LegacyFormat = 'doc' | 'xls' | 'ppt';

function invalid(message: string): never {
  throw new Error(message);
}

function checkPresentationRecords(content: Buffer, start = 0, end = content.length, depth = 0): void {
  if (depth > 64) invalid('PPT 附件记录嵌套过深');
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) invalid('PPT 附件包含损坏的记录');
    const version = content.readUInt16LE(offset) & 0xf;
    const type = content.readUInt16LE(offset + 2);
    const next = offset + 8 + content.readUInt32LE(offset + 4);
    if (next > end) invalid('PPT 附件包含损坏的记录');
    // MS-PPT VBAInfoAtom 的 fHasMacros 不在 CFB 目录中，必须检查记录本身。
    if (type === 0x0400) {
      if (next < offset + 20) invalid('PPT 附件包含损坏的宏记录');
      if (content.readUInt32LE(offset + 12) !== 0) invalid('不支持包含宏的 Office 附件');
    }
    if (version === 0xf) checkPresentationRecords(content, offset + 8, next, depth + 1);
    offset = next;
  }
}

function validateContainer(content: Buffer, format: LegacyFormat): void {
  if (!content.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
    invalid('旧版 Office 附件实际格式与声明类型不符');
  }
  const container = CFB.read(content, { type: 'buffer' });
  if (container.FileIndex.length > 2_048) invalid('Office 附件包含过多条目');
  let totalBytes = 0;
  for (const entry of container.FileIndex) {
    if (/^(?:VBA|Macros|_VBA_PROJECT(?:_CUR)?|VBAProject|VBAStorage)$/i.test(entry.name)) {
      invalid('不支持包含宏的 Office 附件');
    }
    if (/^(?:EncryptionInfo|EncryptedPackage|EncryptedSummary)$/i.test(entry.name)) {
      invalid('不支持加密 Office 附件，请先解密后上传');
    }
    if (entry.type !== 2) continue;
    if (entry.size !== entry.content.length) invalid('Office 附件流内容损坏');
    totalBytes += entry.size;
    if (totalBytes > content.length) invalid('Office 附件流总量超过容器大小');
  }
  const root = container.FullPaths[0];
  const stream = (name: string) => {
    const index = container.FullPaths.indexOf(`${root}${name}`);
    const entry = container.FileIndex[index];
    return entry?.type === 2 ? Buffer.from(entry.content) : undefined;
  };
  const main = format === 'doc' ? stream('WordDocument')
    : format === 'xls' ? stream('Workbook') ?? stream('Book') : stream('PowerPoint Document');
  if (main === undefined || main.length < 16) invalid('旧版 Office 附件缺少对应格式的主文档流');
  if (format === 'doc' && (main.readUInt16LE(10) & 0x8100) !== 0) {
    invalid('不支持加密 Office 附件，请先解密后上传');
  }
  if (format === 'xls') {
    for (let offset = 0; offset < main.length;) {
      if (offset + 4 > main.length) invalid('XLS 附件包含损坏的记录');
      const type = main.readUInt16LE(offset);
      if (type === 0x002f) invalid('不支持加密 Office 附件，请先解密后上传');
      const next = offset + 4 + main.readUInt16LE(offset + 2);
      if (next > main.length) invalid('XLS 附件包含损坏的记录');
      if (type === 0x000a) break;
      offset = next;
    }
  }
  if (format === 'ppt') {
    const user = stream('Current User');
    if (user === undefined || user.length < 16) invalid('PPT 附件缺少有效的用户记录');
    if (user.readUInt32LE(12) === 0xf3d1c4df) invalid('不支持加密 Office 附件，请先解密后上传');
    checkPresentationRecords(main);
  }
}

export async function processLegacyOfficeAttachment(
  content: Buffer, format: LegacyFormat, mode: OfficeWorkerRequest['mode'], maxChars: number
): Promise<OfficeExtraction> {
  validateContainer(content, format);
  // 使用 ESM 入口并从安装包读取 WASM，开发和桌面打包均无需联网或原生依赖。
  initSync({ module: readFileSync(new URL('./office_oxide_bg.wasm', import.meta.resolve('office-oxide-wasm/web'))) });
  let document: WasmDocument;
  try {
    document = new WasmDocument(content, format);
  } catch (error) {
    invalid(`旧版 Office 附件无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (mode === 'validate') return { content: '' };
    if (mode === 'preview') {
      const { previewLegacyOffice } = await import(new URL(
        import.meta.url.endsWith('.ts') ? './office-preview.ts' : './office-preview.js', import.meta.url
      ).href) as typeof import('./office-preview.js');
      return { content: '', preview: previewLegacyOffice(document.toIr(), format) };
    }
    const text = document.toMarkdown().replace(/\r\n?/g, '\n').trim();
    return {
      content: (text || '[无可提取文字]').slice(0, maxChars),
      detail: '正文及表格；未读取图片内容'
        + (format === 'xls' ? '；不重算公式' : '')
        + (text.length > maxChars ? '；内容已截断（超出附件文字上限）' : '')
    };
  } finally {
    document.free();
  }
}
