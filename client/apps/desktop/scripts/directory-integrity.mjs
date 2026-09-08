import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export async function inspectDirectory(directory) {
  const root = resolve(directory);
  const files = listRelativeFiles(root);
  const entries = [];
  const aggregate = createHash('sha256');
  for (const path of files) {
    const absolutePath = join(root, path);
    const stat = lstatSync(absolutePath);
    const sha256 = await hashFile(absolutePath);
    entries.push({
      path,
      sha256,
      mode: stat.mode & 0o777
    });
    aggregate.update(path).update('\0').update(sha256).update('\0');
  }
  return {
    files,
    entries,
    fileCount: files.length,
    hash: aggregate.digest('hex')
  };
}

export function findDirectoryDifference(
  left,
  right,
  options = {}
) {
  const count = Math.max(left.files.length, right.files.length);
  for (let index = 0; index < count; index += 1) {
    if (left.files[index] !== right.files[index]) {
      return {
        kind: 'file-list',
        path: left.files[index] ?? right.files[index] ?? '<missing>'
      };
    }
  }
  for (let index = 0; index < left.entries.length; index += 1) {
    const leftEntry = left.entries[index];
    const rightEntry = right.entries[index];
    if (leftEntry.sha256 !== rightEntry.sha256) {
      return { kind: 'content', path: leftEntry.path };
    }
    if (
      options.compareExecuteBits === true
      && (leftEntry.mode & 0o111) !== (rightEntry.mode & 0o111)
    ) {
      return { kind: 'execute-mode', path: leftEntry.path };
    }
  }
  return undefined;
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function listRelativeFiles(root, current = root) {
  if (!existsSync(root)) {
    throw new Error(`Directory does not exist: ${root}`);
  }
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) {
      throw new Error(`Directory contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(root, path));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Directory contains an unsupported entry: ${relativePath}`);
    }
    if (
      relativePath.startsWith('../')
      || isAbsolute(relativePath)
    ) {
      throw new Error(`Directory entry escapes its root: ${relativePath}`);
    }
    files.push(relativePath);
  }
  return files.sort();
}
