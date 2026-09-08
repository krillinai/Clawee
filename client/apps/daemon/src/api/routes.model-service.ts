import type {
  ConfigureModelServiceRequest
} from '@clawee/protocol';
import type { FastifyInstance } from 'fastify';
import {
  ModelServiceConfigurationError,
  type ModelServiceRuntime
} from '../codex/model-service-configuration.js';
import { apiError } from './errors.js';
import type {
  EnterpriseSessionManager
} from '../enterprise/session-manager-2026-07-30.js';
import type {
  EnterpriseHttpClient
} from '../enterprise/http-client-2026-07-30.js';

export async function registerModelServiceRoutes(
  server: FastifyInstance,
  input: {
    runtime: ModelServiceRuntime;
    sessionManager: EnterpriseSessionManager;
    httpClient: EnterpriseHttpClient;
  }
): Promise<void> {
  server.get('/runtime/model-service', async () => input.runtime.status());

  server.post('/runtime/model-service/retry', async (_request, reply) => {
    let accessToken: string;
    try {
      accessToken = await input.sessionManager.requireAccessToken();
    } catch {
      return reply.code(401).send(apiError(
        'enterprise_session_required',
        'enterprise session is required'
      ));
    }
    await input.runtime.resolve(
      accessToken,
      token => {
        const getConfiguration = input.httpClient.getModelConfiguration;
        if (getConfiguration === undefined) {
          throw new Error('MODEL_CONFIGURATION_UNAVAILABLE');
        }
        return getConfiguration(token);
      }
    );
    const state = input.runtime.status();
    if (
      state.status === 'unavailable'
      && state.code === 'ENTERPRISE_UNAUTHORIZED'
    ) {
      await input.sessionManager.invalidateUnauthorized();
      return reply.code(401).send(apiError(
        'enterprise_session_required',
        'enterprise session is required'
      ));
    }
    return state;
  });

  server.post<{ Body: ConfigureModelServiceRequest }>(
    '/runtime/model-service/configure',
    async (request, reply) => {
      try {
        await input.sessionManager.requireAccessToken();
      } catch {
        return reply.code(401).send(apiError(
          'enterprise_session_required',
          'enterprise session is required'
        ));
      }
      try {
        return await input.runtime.configure(request.body);
      } catch (error) {
        if (!(error instanceof ModelServiceConfigurationError)) throw error;
        return reply
          .code(statusCode(error))
          .send(apiError(error.code, error.message, error.details));
      }
    }
  );
}

function statusCode(error: ModelServiceConfigurationError): number {
  switch (error.code) {
    case 'MODEL_SERVICE_CONFIGURATION_INVALID':
      return 400;
    case 'MODEL_SERVICE_CONFIGURATION_BUSY':
      return 409;
    case 'MODEL_SERVICE_VALIDATION_FAILED':
      return 422;
    case 'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE':
      return 503;
    case 'model_configuration_managed_by_platform':
      return 409;
  }
}
