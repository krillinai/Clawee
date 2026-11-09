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
import { formatSseEvent } from './sse.js';

export async function registerCodexRoutes(
  server: FastifyInstance,
  input: {
    codexBin: string;
    codexHome: ResolvedCodexHome;
    capabilities: RuntimeCapabilityMatrix;
    modelCatalog: CodexModelCatalog;
    subscribeModelCatalogChanges?(listener: () => void): () => void;
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
      const result = configuredModel === undefined
        ? catalog
        : selectConfiguredModel(catalog, configuredModel);
      return input.subscribeModelCatalogChanges === undefined
        ? result
        : { ...result, updatesAvailable: true };
    } catch {
      if (configuredModel !== undefined) {
        const fallback = selectConfiguredModel({ models: [] }, configuredModel);
        return input.subscribeModelCatalogChanges === undefined
          ? fallback
          : { ...fallback, updatesAvailable: true };
      }
      return reply
        .code(502)
        .send(apiError('CODEX_MODEL_LIST_FAILED', 'Failed to load Codex models'));
    }
  });

  if (input.subscribeModelCatalogChanges !== undefined) {
    const connections = new Map<import('node:http').ServerResponse, () => void>();
    server.get('/codex/models/events', async (request, reply) => {
      for (const [header, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(header, value);
      }
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive'
      });
      const notify = () => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(formatSseEvent({ event: 'changed', data: {} }));
        }
      };
      const unsubscribe = input.subscribeModelCatalogChanges!(notify);
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(': heartbeat\n\n');
      }, 30_000);
      const cleanup = () => {
        if (!connections.delete(reply.raw)) return;
        clearInterval(heartbeat);
        unsubscribe();
      };
      connections.set(reply.raw, cleanup);
      request.raw.on('close', cleanup);
      reply.raw.on('close', cleanup);
      notify();
      return reply;
    });
    server.addHook('preClose', async () => {
      for (const [connection, cleanup] of connections) {
        cleanup();
        const socket = connection.socket;
        connection.end(() => socket?.end());
      }
    });
  }
}
