const ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  '.bash': 'text/plain',
  '.c': 'text/plain',
  '.cfg': 'text/plain',
  '.cjs': 'text/plain',
  '.conf': 'text/plain',
  '.cpp': 'text/plain',
  '.cs': 'text/plain',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.env': 'text/plain',
  '.gif': 'image/gif',
  '.go': 'text/plain',
  '.h': 'text/plain',
  '.hpp': 'text/plain',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ini': 'text/plain',
  '.java': 'text/plain',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/plain',
  '.json': 'application/json',
  '.jsonc': 'text/plain',
  '.jsonl': 'text/plain',
  '.jsx': 'text/plain',
  '.kt': 'text/plain',
  '.kts': 'text/plain',
  '.less': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.mjs': 'text/plain',
  '.ndjson': 'text/plain',
  '.pdf': 'application/pdf',
  '.php': 'text/plain',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.properties': 'text/plain',
  '.ps1': 'text/plain',
  '.py': 'text/plain',
  '.r': 'text/plain',
  '.rb': 'text/plain',
  '.rs': 'text/plain',
  '.scss': 'text/plain',
  '.sh': 'text/plain',
  '.sql': 'text/plain',
  '.svelte': 'text/plain',
  '.swift': 'text/plain',
  '.toml': 'text/plain',
  '.ts': 'text/plain',
  '.tsv': 'text/tab-separated-values',
  '.tsx': 'text/plain',
  '.txt': 'text/plain',
  '.vue': 'text/plain',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'text/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.zsh': 'text/plain'
};

const SUPPORTED_ATTACHMENT_MIME_TYPES = new Set(
  Object.values(ATTACHMENT_MIME_BY_EXTENSION)
);

export const ATTACHMENT_FILE_ACCEPT = [
  ...Object.keys(ATTACHMENT_MIME_BY_EXTENSION),
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
].join(',');

export function resolveAttachmentMime(file: Pick<File, 'name' | 'type'>): string | undefined {
  // 浏览器可能将 CSV 标成 Excel、将 TypeScript 标成视频，优先使用支持的后缀。
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  const inferred = extension === undefined ? undefined : ATTACHMENT_MIME_BY_EXTENSION[extension];
  if (inferred !== undefined) return inferred;
  const declared = file.type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return SUPPORTED_ATTACHMENT_MIME_TYPES.has(declared) ? declared : undefined;
}

export function isImageAttachmentMime(mime: string): boolean {
  return mime.startsWith('image/');
}
