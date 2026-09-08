import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  findDirectoryDifference,
  inspectDirectory
} from './directory-integrity.mjs';

export async function assertCodexRuntimePackage(input) {
  const source = await inspectDirectory(input.sourceDirectory);
  const packaged = await inspectDirectory(input.packagedDirectory);
  const difference = findDirectoryDifference(source, packaged, {
    compareExecuteBits: input.platform !== 'win32'
  });
  if (difference !== undefined) {
    throw new Error(
      `Packaged Codex Runtime differs at ${difference.path}: `
      + difference.kind
    );
  }

  const metadata = JSON.parse(readFileSync(
    join(input.sourceDirectory, 'codex-package.json'),
    'utf8'
  ));
  const expected = {
    version: 2,
    codexRuntimeId: input.runtimeManifest.runtimeId,
    codexRuntimeVersion: input.runtimeManifest.codexVersion,
    codexRuntimeReleaseTag: input.runtimeManifest.releaseTag,
    codexRuntimeTarget: input.target.targetTriple,
    codexRuntimeLayoutVersion: input.runtimeManifest.layoutVersion,
    codexRuntimeEntrypoint: metadata.entrypoint,
    codexRuntimeFileCount: source.fileCount,
    codexRuntimeContentSha256: source.hash,
    codexRuntimeArchiveSha256: input.target.archiveSha256
  };
  for (const [field, value] of Object.entries(expected)) {
    if (input.buildManifest[field] !== value) {
      throw new Error(
        `Desktop build manifest ${field} does not match Codex Runtime: `
        + `${String(input.buildManifest[field])} !== ${String(value)}`
      );
    }
  }
  return {
    contentSha256: source.hash,
    fileCount: source.fileCount,
    files: source.files
  };
}
