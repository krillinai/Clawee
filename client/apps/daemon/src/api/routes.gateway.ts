import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { readEnterpriseClientConfig, serializeEnterpriseClientConfig } from '../enterprise/client-config-2026-08-06.js';
import { resolveEnterpriseOrigin } from '../enterprise/config-2026-07-30.js';
import { apiError } from './errors.js';

export async function registerGatewayRoutes(server: FastifyInstance, input: {
  configPath?: string;
  getOrigin(): string;
  canChange(): boolean;
  clearSession(): Promise<void>;
  activate(origin: string): void;
}) {
  let changing = false;
  server.addHook('preHandler', async (request, reply) => {
    if (changing && request.method !== 'GET') {
      return reply.code(409).send(apiError('VALIDATION_FAILED', '服务端切换中，请稍后重试'));
    }
  });
  server.get('/enterprise/gateway', async () => ({ gateway: input.getOrigin(), configurable: input.configPath !== undefined }));
  server.post('/enterprise/gateway', async (request, reply) => {
    const parsed = z.object({ gateway: z.string().trim().min(1).max(2048) }).strict().safeParse(request.body);
    let gateway: string;
    try {
      if (!parsed.success) throw new Error('invalid input');
      gateway = resolveEnterpriseOrigin(parsed.data.gateway).origin;
      const url = new URL(gateway);
      if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        throw new Error('remote gateway requires https');
      }
    } catch {
      return reply.code(400).send(apiError('VALIDATION_FAILED', '请输入 HTTPS 服务端地址；HTTP 仅限本机'));
    }
    if (!input.configPath || !input.canChange()) {
      return reply.code(409).send(apiError('VALIDATION_FAILED', '请先退出登录并等待运行中的任务结束'));
    }
    if (gateway === input.getOrigin()) return { gateway, configurable: true };
    changing = true;
    const temporary = `${input.configPath}.${randomUUID()}.tmp`;
    try {
      const raw = await readFile(input.configPath, 'utf8');
      const current = readEnterpriseClientConfig(input.configPath, () => raw);
      await writeFile(temporary, serializeEnterpriseClientConfig({ ...current, gateway }), { mode: 0o600, flag: 'wx' });
      await input.clearSession();
      await rename(temporary, input.configPath);
      input.activate(gateway);
      return { gateway, configurable: true };
    } finally {
      await rm(temporary, { force: true });
      changing = false;
    }
  });
}
