import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { readEnterpriseClientConfig, serializeEnterpriseClientConfig } from '../enterprise/client-config-2026-08-06.js';
import { DEFAULT_ENTERPRISE_ORIGIN, resolveEnterpriseOrigin } from '../enterprise/config-2026-07-30.js';
import { apiError } from './errors.js';

export async function registerGatewayRoutes(server: FastifyInstance, input: {
  configPath?: string;
  getOrigin(): string;
  canChange(): boolean;
  clearSession(): Promise<void>;
  activate(origin: string): void;
}) {
  let changing = false;
  async function readConfig() {
    if (!input.configPath) return { gateway: input.getOrigin(), gateways: undefined };
    let raw: string;
    try {
      raw = await readFile(input.configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { gateway: input.getOrigin(), gateways: undefined };
    }
    return readEnterpriseClientConfig(input.configPath, () => raw);
  }
  function configuration(gateways: string[]) {
    return {
      gateway: input.getOrigin() === DEFAULT_ENTERPRISE_ORIGIN ? '' : input.getOrigin(),
      gateways: [...new Set(gateways)].filter(gateway => gateway !== DEFAULT_ENTERPRISE_ORIGIN),
      configurable: input.configPath !== undefined
    };
  }
  server.addHook('preHandler', async (request, reply) => {
    if (changing && request.method !== 'GET') {
      return reply.code(409).send(apiError('VALIDATION_FAILED', '服务端切换中，请稍后重试'));
    }
  });
  server.get('/enterprise/gateway', async () => {
    const current = await readConfig();
    return configuration([...(current.gateways ?? []), input.getOrigin()]);
  });
  server.post('/enterprise/gateway', async (request, reply) => {
    const address = z.string().trim().min(1).max(2048);
    const parsed = z.object({ gateway: address, gateways: z.array(address).max(100).optional() }).strict().safeParse(request.body);
    let gateway: string;
    let gateways: string[] | undefined;
    try {
      if (!parsed.success) throw new Error('invalid input');
      gateway = resolveEnterpriseOrigin(parsed.data.gateway).origin;
      if (gateway === DEFAULT_ENTERPRISE_ORIGIN) throw new Error('invalid input');
      if (parsed.data.gateways !== undefined) {
        gateways = [...new Set(parsed.data.gateways.map(value => resolveEnterpriseOrigin(value).origin))];
        if (!gateways.includes(gateway) || gateways.includes(DEFAULT_ENTERPRISE_ORIGIN)) throw new Error('invalid input');
      }
    } catch {
      return reply.code(400).send(apiError('VALIDATION_FAILED', '请输入有效的 HTTP 或 HTTPS 服务端地址'));
    }
    const switching = gateway !== input.getOrigin();
    if (!input.configPath || (switching && !input.canChange())) {
      return reply.code(409).send(apiError('VALIDATION_FAILED', '请先退出登录并等待运行中的任务结束'));
    }
    changing = true;
    const temporary = `${input.configPath}.${randomUUID()}.tmp`;
    try {
      const current = await readConfig();
      gateways = configuration(gateways ?? [...(current.gateways ?? [current.gateway]), gateway]).gateways;
      await mkdir(dirname(input.configPath), { recursive: true });
      await writeFile(temporary, serializeEnterpriseClientConfig({ ...current, gateway, gateways }), { mode: 0o600, flag: 'wx' });
      if (switching) await input.clearSession();
      await rename(temporary, input.configPath);
      if (switching) input.activate(gateway);
      return configuration(gateways);
    } finally {
      await rm(temporary, { force: true });
      changing = false;
    }
  });
}
