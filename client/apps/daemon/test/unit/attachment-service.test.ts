import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AttachmentServiceError,
  createAttachmentService
} from '../../src/attachments/service.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn6zkAAAAAASUVORK5CYII=',
  'base64'
);

let tempDir = '';
let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('attachment service', () => {
  it('stores verified content under generated paths and deduplicates within a draft', async () => {
    const service = setup();

    const first = await service.upload({
      draftId: 'draft-1',
      fileName: '../../avatar.png',
      mime: 'image/png',
      content: PNG
    });
    const duplicate = await service.upload({
      draftId: 'draft-1',
      fileName: 'copy.png',
      mime: 'image/png',
      content: PNG
    });
    const anotherDraft = await service.upload({
      draftId: 'draft-2',
      fileName: 'avatar.png',
      mime: 'image/png',
      content: PNG
    });

    expect(first.deduplicated).toBe(false);
    expect(first.attachment).toMatchObject({
      fileName: 'avatar.png',
      mime: 'image/png',
      size: PNG.length,
      draftId: 'draft-1',
      status: 'draft'
    });
    expect(first.attachment.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.attachment.storageKey).toMatch(/^[a-zA-Z0-9_-]{2}\/[a-zA-Z0-9_-]+\.bin$/);
    expect(
      resolve(tempDir, 'attachments', first.attachment.storageKey).startsWith(
        `${resolve(tempDir, 'attachments')}${sep}`
      )
    ).toBe(true);
    expect(existsSync(resolve(tempDir, 'attachments', first.attachment.storageKey))).toBe(true);
    expect(duplicate).toEqual({
      attachment: first.attachment,
      deduplicated: true
    });
    expect(anotherDraft.attachment.id).not.toBe(first.attachment.id);

    const loaded = await service.read({
      id: first.attachment.id,
      draftId: 'draft-1'
    });
    expect(loaded.content).toEqual(PNG);
    await expect(
      service.read({ id: first.attachment.id, draftId: 'draft-2' })
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_ACCESS_DENIED',
      statusCode: 403
    });
  });

  it('rejects oversized, unsupported, mismatched, and ownerless uploads without files', async () => {
    const service = setup({ maxSizeBytes: PNG.length - 1 });

    await expect(
      service.upload({
        draftId: 'draft-1',
        fileName: 'avatar.png',
        mime: 'image/png',
        content: PNG
      })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE', statusCode: 413 });
    await expect(
      service.upload({
        draftId: 'draft-1',
        fileName: 'payload.svg',
        mime: 'image/svg+xml',
        content: Buffer.from('<svg/>')
      })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED', statusCode: 415 });
    await expect(
      service.upload({
        draftId: 'draft-1',
        fileName: 'fake.png',
        mime: 'image/png',
        content: Buffer.from('not a png')
      })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_MISMATCH', statusCode: 415 });
    await expect(
      service.upload({
        fileName: 'avatar.png',
        mime: 'image/png',
        content: PNG
      })
    ).rejects.toBeInstanceOf(AttachmentServiceError);
    expect(service.listStorageFiles()).toEqual([]);
  });

  it('refuses generated storage paths whose parent was replaced by a symlink', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-attachments-'));
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const outsideDir = join(tempDir, 'outside');
    mkdirSync(outsideDir);
    const service = createAttachmentService({
      db,
      dataDir: tempDir,
      createId: () => 'aa-attachment'
    });
    symlinkSync(
      outsideDir,
      join(tempDir, 'attachments', 'aa'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    await expect(
      service.upload({
        draftId: 'draft-1',
        fileName: 'avatar.png',
        mime: 'image/png',
        content: PNG
      })
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_STORAGE_FAILED',
      statusCode: 500
    });
    expect(existsSync(join(outsideDir, 'aa-attachment.bin'))).toBe(false);
  });

  it('persists committed metadata, deletes content, and cleans expired draft attachments', async () => {
    let now = new Date('2026-07-01T00:00:00.000Z');
    const service = setup({ now: () => now });
    const committed = await service.upload({
      draftId: 'draft-committed',
      fileName: 'committed.png',
      mime: 'image/png',
      content: PNG
    });
    const expired = await service.upload({
      draftId: 'draft-expired',
      fileName: 'expired.png',
      mime: 'image/png',
      content: PNG
    });

    await service.commit({
      ids: [committed.attachment.id],
      draftId: 'draft-committed',
      threadId: 'thread-1',
      runId: 'run-1'
    });
    now = new Date('2026-07-09T00:00:00.000Z');
    const cleanup = await service.cleanupExpiredDrafts();

    expect(cleanup.deletedIds).toEqual([expired.attachment.id]);
    expect(await service.getMetadata({
      id: committed.attachment.id,
      threadId: 'thread-1'
    })).toMatchObject({
      id: committed.attachment.id,
      threadId: 'thread-1',
      runId: 'run-1',
      status: 'committed'
    });
    expect(service.listByRun('run-1')).toEqual([
      expect.objectContaining({ id: committed.attachment.id, runId: 'run-1' })
    ]);
    expect(service.listByThread('thread-1')).toEqual([
      expect.objectContaining({
        id: committed.attachment.id,
        threadId: 'thread-1',
        runId: 'run-1',
        status: 'committed'
      })
    ]);
    expect(service.listByThread('thread-other')).toEqual([]);
    expect(await service.resolveForRun({
      ids: [committed.attachment.id],
      threadId: 'thread-1'
    })).toEqual({
      imagePaths: [
        realpathSync(resolve(
          tempDir,
          'attachments',
          committed.attachment.storageKey
        ))
      ]
    });
    await expect(
      service.getMetadata({ id: expired.attachment.id, draftId: 'draft-expired' })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND', statusCode: 404 });

    const persistedService = createAttachmentService({ db: db!, dataDir: tempDir });
    expect(await persistedService.getMetadata({
      id: committed.attachment.id,
      threadId: 'thread-1'
    })).toMatchObject({ status: 'committed' });

    await persistedService.delete({
      id: committed.attachment.id,
      threadId: 'thread-1'
    });
    await expect(
      persistedService.read({ id: committed.attachment.id, threadId: 'thread-1' })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND', statusCode: 404 });
    expect(persistedService.listStorageFiles()).toEqual([]);
  });

  it.each([
    ['data.csv', 'text/csv', 'name,value\nrose,10'],
    ['data.tsv', 'text/tab-separated-values', 'name\tvalue\nrose\t10'],
    ['config.yaml', 'text/yaml', 'enabled: true'],
    ['config.xml', 'text/xml', '<config enabled="true"/>'],
    ['page.html', 'text/html', '<script>window.attachmentExecuted = true;</script>'],
    ['styles.css', 'text/css', 'body { color: red; }'],
    ['main.ts', 'text/plain', 'export const enabled = true;'],
    ['app.log', 'text/plain', 'INFO application started'],
    ['config.toml', 'text/plain', '[app]\nenabled = true']
  ])('stores %s and passes its raw text into run context', async (fileName, mime, text) => {
    const service = setup();
    const uploaded = await service.upload({
      draftId: 'draft-text',
      fileName,
      mime,
      content: Buffer.from(text)
    });
    const resolved = await service.resolveForRun({
      ids: [uploaded.attachment.id],
      draftId: 'draft-text'
    });

    expect(uploaded.attachment.mime).toBe(mime);
    expect(resolved.imagePaths).toEqual([]);
    expect(resolved.textContext).toContain(`${fileName}（${mime}）`);
    expect(resolved.textContext).toContain(text);
  });

  it.each([
    'text/csv', 'text/tab-separated-values', 'text/yaml',
    'text/xml', 'text/html', 'text/css', 'text/plain'
  ])('rejects binary and invalid UTF-8 content declared as %s', async mime => {
    const service = setup();
    for (const content of [PNG, Buffer.from([0xc3, 0x28]), Buffer.from('text\u0000binary')]) {
      await expect(service.upload({
        draftId: 'draft-text',
        fileName: 'disguised.txt',
        mime,
        content
      })).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_MISMATCH', statusCode: 415 });
    }
    expect(service.listStorageFiles()).toEqual([]);
  });

  it('keeps file and total context limits for expanded text attachments', async () => {
    const service = setup();
    const ids: string[] = [];
    for (const [fileName, mime, text] of [
      ['data.csv', 'text/csv', 'a'.repeat(40_001)],
      ['config.yaml', 'text/yaml', 'b'.repeat(40_001)],
      ['main.ts', 'text/plain', 'omitted source code']
    ] as const) {
      const uploaded = await service.upload({
        draftId: 'draft-large', fileName, mime, content: Buffer.from(text)
      });
      ids.push(uploaded.attachment.id);
    }
    const resolved = await service.resolveForRun({ ids, draftId: 'draft-large' });

    expect(resolved.textContext).toContain('a'.repeat(40_000));
    expect(resolved.textContext).not.toContain('a'.repeat(40_001));
    expect(resolved.textContext).toContain('b'.repeat(40_000));
    expect(resolved.textContext).not.toContain('b'.repeat(40_001));
    expect(resolved.textContext).toContain('内容已截断');
    expect(resolved.textContext).toContain('[内容因附件总量限制未注入]');
    expect(resolved.textContext).not.toContain('omitted source code');
  });

  it('extracts PDF and text attachments into bounded run context', async () => {
    const service = setup();
    const pdf = await service.upload({
      draftId: 'draft-documents',
      fileName: 'requirements.pdf',
      mime: 'application/pdf',
      content: createTextPdf('PDF project requirements')
    });
    const markdown = await service.upload({
      draftId: 'draft-documents',
      fileName: 'notes.md',
      mime: 'text/markdown',
      content: Buffer.from('# Notes\nUse the shared runtime.')
    });

    const resolved = await service.resolveForRun({
      ids: [pdf.attachment.id, markdown.attachment.id],
      draftId: 'draft-documents'
    });

    expect(resolved.imagePaths).toEqual([]);
    expect(resolved.textContext).toContain(
      '附件 1：requirements.pdf（application/pdf；1 页）'
    );
    expect(resolved.textContext).toContain('PDF project requirements');
    expect(resolved.textContext).toContain('附件 2：notes.md（text/markdown）');
    expect(resolved.textContext).toContain('Use the shared runtime.');
  });
});

function setup(overrides: {
  maxSizeBytes?: number;
  now?: () => Date;
} = {}) {
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-attachments-'));
  db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
  return createAttachmentService({
    db,
    dataDir: tempDir,
    ...overrides
  });
}

function createTextPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  body += offsets.slice(1).map(offset => (
    `${String(offset).padStart(10, '0')} 00000 n \n`
  )).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}
