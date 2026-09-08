import { resolve } from 'node:path';
import {
  buildServer as buildRuntimeServer,
  type BuildServerInput as RuntimeBuildServerInput
} from '../../src/api/server.js';

export type BuildServerInput =
  Omit<RuntimeBuildServerInput, 'codexBin' | 'codexHome'>
  & {
    codexBin?: string;
    codexHome?: string;
  };

export function buildServer(input: BuildServerInput) {
  const defaultRoot = input.dataDir ?? '.runtime';
  return buildRuntimeServer({
    ...input,
    codexBin: input.codexBin ?? resolve(
      defaultRoot,
      '__test_codex_runtime_not_configured__'
    ),
    codexHome:
      input.codexHome
      ?? input.resolvedCodexHome?.path
      ?? resolve(defaultRoot, '__test_codex_home__')
  });
}
