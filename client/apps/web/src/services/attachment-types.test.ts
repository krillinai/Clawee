import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_FILE_ACCEPT,
  resolveAttachmentMime
} from './attachment-types.js';

describe('attachment types', () => {
  it.each([
    ['csv', 'text/csv'],
    ['tsv', 'text/tab-separated-values'],
    ['yaml', 'text/yaml'],
    ['yml', 'text/yaml'],
    ['xml', 'text/xml'],
    ['html', 'text/html'],
    ['htm', 'text/html'],
    ['css', 'text/css'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ...[
      'log', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
      'jsonc', 'jsonl', 'ndjson', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
      'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php',
      'swift', 'kt', 'kts', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'r',
      'vue', 'svelte', 'scss', 'less'
    ].map(extension => [extension, 'text/plain'])
  ])('recognizes .%s and includes it in the file picker', (extension, mime) => {
    expect(resolveAttachmentMime({ name: `notes.${extension.toUpperCase()}`, type: '' }))
      .toBe(mime);
    expect(ATTACHMENT_FILE_ACCEPT.split(',')).toContain(`.${extension}`);
  });

  it.each([
    ['data.csv', 'application/vnd.ms-excel', 'text/csv'],
    ['index.ts', 'video/mp2t', 'text/plain'],
    ['config.yaml', 'application/yaml', 'text/yaml'],
    ['config.xml', 'application/xml', 'text/xml'],
    ['index.js', 'application/javascript', 'text/plain'],
    ['config.json', 'text/plain', 'application/json']
  ])('uses the supported extension for %s regardless of browser MIME', (name, type, mime) => {
    expect(resolveAttachmentMime({ name, type })).toBe(mime);
  });

  it.each([
    ['image.png', 'image/png'],
    ['image.jpg', 'image/jpeg'],
    ['image.jpeg', 'image/jpeg'],
    ['image.gif', 'image/gif'],
    ['image.webp', 'image/webp'],
    ['document.pdf', 'application/pdf'],
    ['notes.md', 'text/markdown'],
    ['notes.txt', 'text/plain'],
    ['data.json', 'application/json']
  ])('preserves existing support for %s', (name, mime) => {
    expect(resolveAttachmentMime({ name, type: '' })).toBe(mime);
  });

  it('preserves MIME fallback without accepting arbitrary MIME types', () => {
    expect(resolveAttachmentMime({ name: 'notes', type: 'TEXT/PLAIN; charset=utf-8' }))
      .toBe('text/plain');
    expect(resolveAttachmentMime({ name: 'data.bin', type: 'application/octet-stream' }))
      .toBeUndefined();
    expect(resolveAttachmentMime({ name: 'photo.svg', type: 'image/svg+xml' }))
      .toBeUndefined();
    expect(resolveAttachmentMime({ name: 'workbook.xls', type: 'application/vnd.ms-excel' }))
      .toBeUndefined();
  });
});
