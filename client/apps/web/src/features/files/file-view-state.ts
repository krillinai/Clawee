import type { WorkspaceFileNode } from '@clawee/protocol';

export function mergeDirectoryNodes(
  existing: WorkspaceFileNode[],
  directoryPath: string,
  nodes: WorkspaceFileNode[]
): WorkspaceFileNode[] {
  const childPaths = new Set(nodes.map((node) => node.path));
  const next: WorkspaceFileNode[] = [];
  let inserted = false;

  for (const node of existing) {
    if (isTargetDirectoryNode(node, directoryPath)) {
      next.push(node);
      next.push(...nodes);
      inserted = true;
      continue;
    }

    const directChild = directChildPath(directoryPath, node.path);
    if (directChild !== undefined) {
      if (childPaths.has(directChild)) {
        if (directChild === node.path) {
          continue;
        }
        next.push(node);
      }
      continue;
    }

    next.push(node);
  }

  if (!inserted) {
    return directoryPath.length === 0 ? [...nodes, ...next] : [...next, ...nodes];
  }

  return next;
}

export function parentDirectories(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const parents: string[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join('/'));
  }

  return parents;
}

export function filterDirectoryNodesByPaths(
  nodes: WorkspaceFileNode[],
  paths: string[]
): WorkspaceFileNode[] {
  const allowedFiles = new Set(
    paths
      .map(normalizeWorkspacePath)
      .filter(path => path.length > 0)
  );
  if (allowedFiles.size === 0) return [];

  return nodes.filter(node => {
    const nodePath = normalizeWorkspacePath(node.path);
    if (node.type === 'file') return allowedFiles.has(nodePath);
    return [...allowedFiles].some(path => path.startsWith(`${nodePath}/`));
  });
}

function isTargetDirectoryNode(node: WorkspaceFileNode, directoryPath: string): boolean {
  return node.type === 'directory' && node.path === directoryPath;
}

function directChildPath(directoryPath: string, path: string): string | undefined {
  const parentPath = parentPathOf(path);
  if (parentPath === directoryPath) {
    return path;
  }

  if (directoryPath.length === 0) {
    const segments = path.split('/').filter(Boolean);
    if (segments.length > 1) {
      return segments[0] ?? undefined;
    }
    if (segments.length === 1) {
      return path;
    }
  }

  if (directoryPath.length === 0 || !path.startsWith(`${directoryPath}/`)) {
    return undefined;
  }

  const suffix = path.slice(directoryPath.length + 1);
  const childName = suffix.split('/')[0];
  return childName === undefined ? undefined : `${directoryPath}/${childName}`;
}

function parentPathOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}
