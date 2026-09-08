import type { FastifyInstance } from 'fastify';
import type {
  CodexAvailabilityProbe,
  CodexRuntimeStatus
} from '@clawee/protocol';
import type { RuntimeCapabilityMatrix } from '../codex/capabilities.js';
import type { ResolvedCodexHome } from '../codex/home.js';
import {
  selectConfiguredModel,
  type CodexModelCatalog
} from '../codex/model-catalog-2026-08-05.js';
import { buildCodexStatusResponse } from '../codex/status.js';
import { apiError } from './errors.js';

export async function registerCodexRoutes(
  server: FastifyInstance,
  input: {
    codexBin: string;
    codexHome: ResolvedCodexHome;
    capabilities: RuntimeCapabilityMatrix;
    modelCatalog: CodexModelCatalog;
    getConfiguredModel?(): string | undefined;
    getAvailabilityProbe?(): CodexAvailabilityProbe | undefined;
    getRuntimeStatus(): CodexRuntimeStatus;
  }
): Promise<void> {
  server.get('/codex/status', async () => buildCodexStatusResponse({
    ...input,
    runtime: input.getRuntimeStatus(),
    availabilityProbe: input.getAvailabilityProbe?.()
  }));

  server.get('/codex/models', async (_request, reply) => {
    const configuredModel = input.getConfiguredModel?.();
    try {
      const catalog = await input.modelCatalog.listModels();
      return configuredModel === undefined
        ? catalog
        : selectConfiguredModel(catalog, configuredModel);
    } catch {
      if (configuredModel !== undefined) {
        return selectConfiguredModel({ models: [] }, configuredModel);
      }
      return reply
        .code(502)
        .send(apiError('CODEX_MODEL_LIST_FAILED', 'Failed to load Codex models'));
    }
  });
}
