import type {
  CodexStatusResponse,
  ModelAccessState,
  RuntimeHealthResponse
} from '@clawee/protocol';
import { ApiClientError, type RuntimeClient } from '../runtime/client.js';

export type ConnectionState =
  | { status: 'disconnected'; message: string }
  | { status: 'connected'; codexStatus: CodexStatusResponse }
  | {
      status: 'configuration_required';
      configuration: ModelAccessState;
    }
  | { status: 'invalid_token'; message: string };

type ClientLike = Pick<RuntimeClient, 'get'>;

export function createConnectionService(client: ClientLike) {
  return {
    async check(): Promise<ConnectionState> {
      try {
        const health = await client.get<RuntimeHealthResponse>('/healthz');
        if (health.runtimeState === 'configuration_required') {
          const configuration =
            await client.get<ModelAccessState>(
              '/runtime/model-service'
            );
          return { status: 'configuration_required', configuration };
        }
        const codexStatus = await client.get<CodexStatusResponse>('/codex/status');
        return { status: 'connected', codexStatus };
      } catch (error) {
        const message = errorMessage(error);
        if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
          return { status: 'invalid_token', message };
        }
        return { status: 'disconnected', message };
      }
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Runtime connection failed';
}
