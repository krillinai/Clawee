import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  EnterpriseHttpClient,
  EnterprisePlatformBrandingImage
} from '../enterprise/http-client-2026-07-30.js';
import { EnterpriseHttpError } from '../enterprise/http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from '../enterprise/session-manager-2026-07-30.js';
import { EnterpriseSessionError } from '../enterprise/session-manager-2026-07-30.js';
import { apiError } from './errors.js';

export async function registerEnterprisePlatformBrandingRoutes(
  server: FastifyInstance,
  input: {
    sessionManager: EnterpriseSessionManager;
    httpClient: EnterpriseHttpClient;
  }
): Promise<void> {
  server.get('/enterprise/platform-branding', async (_request, reply) => {
    try {
      const accessToken = await input.sessionManager.requireAccessToken();
      const load = input.httpClient.getPlatformBranding;
      if (load === undefined) return unavailable(reply);
      reply.header('Cache-Control', 'no-store');
      return await load(accessToken);
    } catch (error) {
      return brandingError(reply, error, input.sessionManager);
    }
  });

  for (const kind of ['sidebar-logo', 'sidebar-compact-logo'] as const) {
    server.get(`/enterprise/platform-branding/${kind}`, async (_request, reply) => {
      try {
        const accessToken = await input.sessionManager.requireAccessToken();
        const load = input.httpClient.getPlatformBrandingImage;
        if (load === undefined) return unavailable(reply);
        return sendImage(reply, await load(accessToken, kind));
      } catch (error) {
        return brandingError(reply, error, input.sessionManager);
      }
    });
  }
}

function sendImage(reply: FastifyReply, image: EnterprisePlatformBrandingImage) {
  return reply
    .header('Cache-Control', 'no-store')
    .type(image.contentType)
    .send(Buffer.from(image.content));
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send(apiError(
    'ENTERPRISE_SERVICE_UNAVAILABLE',
    'Enterprise platform branding is unavailable'
  ));
}

async function brandingError(
  reply: FastifyReply,
  error: unknown,
  sessionManager: EnterpriseSessionManager
) {
  if (error instanceof EnterpriseSessionError) {
    return reply.code(error.statusCode).send(apiError(error.code, 'Enterprise session expired'));
  }
  if (error instanceof EnterpriseHttpError) {
    if (error.code === 'ENTERPRISE_UNAUTHORIZED') {
      await sessionManager.invalidateUnauthorized();
      return reply.code(401).send(apiError('ENTERPRISE_SESSION_EXPIRED', 'Enterprise session expired'));
    }
    return reply.code(error.statusCode ?? 502).send(apiError(error.code, 'Enterprise platform branding is unavailable'));
  }
  throw error;
}
