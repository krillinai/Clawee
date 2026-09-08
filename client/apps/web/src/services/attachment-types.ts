const ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.webp': 'image/webp'
};

const SUPPORTED_ATTACHMENT_MIME_TYPES = new Set(
  Object.values(ATTACHMENT_MIME_BY_EXTENSION)
);

export const ATTACHMENT_FILE_ACCEPT = [
  '.pdf',
  '.md',
  '.txt',
  '.json',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
].join(',');

export function resolveAttachmentMime(file: Pick<File, 'name' | 'type'>): string | undefined {
  const declared = file.type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (SUPPORTED_ATTACHMENT_MIME_TYPES.has(declared)) return declared;
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  return extension === undefined ? undefined : ATTACHMENT_MIME_BY_EXTENSION[extension];
}

export function isImageAttachmentMime(mime: string): boolean {
  return mime.startsWith('image/');
}
