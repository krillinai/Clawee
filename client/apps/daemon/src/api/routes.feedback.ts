import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FeedbackService } from '../feedback/service.js';
import { apiError } from './errors.js';

export async function registerFeedbackRoutes(server: FastifyInstance, service: FeedbackService) {
  const draft = z.object({ thread_id: z.string().min(1).max(128), description: z.string().trim().min(1).max(10000), occurred_at: z.string().datetime({ offset: true }), reproduction_steps: z.string().max(10000).optional() }).strict();
  const native = z.object({ environment: z.record(z.string().max(256)), records: z.array(z.unknown()).max(500), warnings: z.array(z.string().max(256)).max(20) }).strict();
  type Request = FastifyRequest<{ Params: { id: string; screenshotId: string } }>;
  const action = (fn: (request: Request) => Promise<unknown>, status = 200) => async (request: FastifyRequest, reply: FastifyReply) => { try { reply.header('Cache-Control', 'no-store'); return reply.code(status).send(await fn(request as Request)); } catch { return reply.code(400).send(apiError('VALIDATION_FAILED', '反馈请求未完成，请检查状态、授权或部署策略')); } };
  server.get('/feedback/policy', action(async () => ({ external_feedback_allowed: await service.allowed() })));
  server.post('/feedback/diagnostics', { bodyLimit: 4096 }, action(async request => {
    const body = z.object({ thread_id: z.string().max(128), source: z.literal('web'), error_code: z.enum(['network_failed', 'http_failed', 'browser_error', 'unhandled_rejection']), method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']).optional(), route: z.string().max(256).optional(), status: z.number().int().min(0).max(599).optional() }).strict().parse(request.body);
    service.recordDiagnostic(body.thread_id, { ...body, request_id: request.id }); return { recorded: true };
  }, 202));
  server.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 400 || request.routeOptions.url?.startsWith('/feedback')) return;
    const params = request.params as Record<string, unknown> | undefined; const body = request.body as Record<string, unknown> | undefined;
    let threadId = params?.threadId ?? body?.thread_id;
    const runId = params?.runId ?? body?.run_id;
    if (typeof threadId !== 'string' && typeof runId === 'string') threadId = service.threadForRun(runId);
    if (typeof threadId === 'string') service.recordDiagnostic(threadId, { source: 'daemon', route: request.routeOptions.url, method: request.method, status: reply.statusCode, request_id: request.id, run_id: typeof runId === 'string' ? runId : undefined });
  });
  server.post('/feedback/drafts', { bodyLimit: 100000 }, action(request => service.create(draft.parse(request.body)), 201));
  server.get('/feedback/drafts/:id', action(request => service.get(request.params.id)));
  server.post('/feedback/drafts/:id/collect', { bodyLimit: 256 * 1024 }, action(async request => { const body = z.object({ native: native.optional() }).strict().parse(request.body ?? {}); await service.collect(request.params.id, body.native); return { collecting: true }; }, 202));
  server.post('/feedback/drafts/:id/send', action(async request => { const body = z.object({ confirmed: z.literal(true), manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/), accept_partial: z.boolean() }).strict().parse(request.body); await service.send(request.params.id, body); return { queued: true }; }, 202));
  server.post('/feedback/drafts/:id/retry', action(async request => { await service.retry(request.params.id); return { queued: true }; }, 202));
  server.post('/feedback/drafts/:id/cancel', action(request => service.cancel(request.params.id)));
  server.delete('/feedback/drafts/:id/screenshots/:screenshotId', action(async request => { await service.removeScreenshot(request.params.id, request.params.screenshotId); return { removed: true }; }));
  server.register(async scoped => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) scoped.addContentTypeParser(mime, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    scoped.post('/feedback/drafts/:id/screenshots', { bodyLimit: 10 * 1024 * 1024 }, action(request => service.screenshot(request.params.id, Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0), request.headers['content-type'] ?? ''), 201));
  });
  server.get('/feedback/drafts/:id/export', action(request => service.export(request.params.id)));
  server.get<{ Params: { id: string; artifactId: string } }>('/feedback/drafts/:id/artifacts/:artifactId', async (request, reply) => { try { reply.header('Content-Disposition', 'attachment'); reply.type('application/octet-stream'); return reply.send(await service.artifact(request.params.id, request.params.artifactId)); } catch { return reply.code(404).send(apiError('VALIDATION_FAILED', '反馈附件不可用')); } });
  server.addHook('onClose', async () => service.close()); service.start();
}
