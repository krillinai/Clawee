import type { TimelineItem } from '../../components/timeline/timeline-model.js';
import { extractWorkspaceFilePaths } from '../../components/markdown/markdown-inline.js';

const DELIVERABLE_EXTENSIONS = new Set([
  'csv',
  'doc',
  'docx',
  'htm',
  'html',
  'md',
  'markdown',
  'pdf',
  'ppt',
  'pptx',
  'xls',
  'xlsx'
]);

export function collectConversationFilePaths(items: TimelineItem[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'change_card') {
      addPath(item.path);
      continue;
    }
    if (item?.kind !== 'assistant_message') continue;

    const messagePaths = extractWorkspaceFilePaths(item.text);
    for (let pathIndex = messagePaths.length - 1; pathIndex >= 0; pathIndex -= 1) {
      const path = messagePaths[pathIndex];
      if (path !== undefined && isDeliverablePath(path)) addPath(path);
    }
  }

  return paths;

  function addPath(path: string) {
    const trimmed = path.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    paths.push(trimmed);
  }
}

function isDeliverablePath(path: string): boolean {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return extension !== undefined && DELIVERABLE_EXTENSIONS.has(extension);
}
