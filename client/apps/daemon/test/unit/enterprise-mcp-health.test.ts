import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTaskMcpRoutes } from '../../src/api/routes.task-mcp.js';
import { checkEnterpriseMcpHealth } from '../../src/enterprise/mcp-health.js';
import type { TaskMcpService } from '../../src/task-mcp/service.js';

const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  vi.restoreAllMocks();
});

describe('企业 MCP 健康检查', () => {
  it.each([
    ['ready', 'configured', 'ready', '实际执行以任务结果为准'],
    ['ready', 'configuration_required', 'attention', '模型配置未就绪'],
    ['unavailable', 'configured', 'attention', 'Runtime 未就绪'],
    ['unknown', 'configured', 'unknown', '部分执行条件尚未确认']
  ])('经 MCP 查询 %s / %s，不执行任务', async (runtime, model, status, message) => {
    const getHealth = vi.fn(() => ({ runtime, model }));
    const endpoint = await startServer({ getHealth } as unknown as TaskMcpService);
    const result = await checkEnterpriseMcpHealth({ endpoint, toolName: 'clawee_get_agent_health', token: 'test-account-secret', agentId: 'test-agent' });
    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status, checks: { runtime, model } });
    expect(result.message).toContain(message);
    expect(JSON.stringify(result)).not.toContain('test-account-secret');
  });

  it.each([401, 403])('HTTP %s 是身份或权限问题，不判定 Agent 离线', async status => {
    const endpoint = await startServer({} as TaskMcpService, status);
    const result = await checkEnterpriseMcpHealth({ endpoint, toolName: 'clawee_get_agent_health', token: 'test-account-secret', agentId: 'test-agent' });
    expect(result.status).toBe('attention');
    expect(result.message).toContain('身份验证或授权失败');
  });

  it('工具不可见时不尝试调用，检查结果不包含旧的就绪状态', async () => {
    const getHealth = vi.fn();
    const endpoint = await startServer({ getHealth } as unknown as TaskMcpService);
    const result = await checkEnterpriseMcpHealth({ endpoint, toolName: 'not-authorized', token: 'test-account-secret', agentId: 'test-agent' });
    expect(result.status).toBe('attention');
    expect(getHealth).not.toHaveBeenCalled();
  });

  it('工具错误不泄露上游诊断或凭据，恢复后可再次检查', async () => {
    const getHealth = vi.fn().mockImplementationOnce(() => { throw new Error('upstream unavailable: private-secret'); })
      .mockReturnValue({ runtime: 'ready', model: 'configured' });
    const endpoint = await startServer({ getHealth } as unknown as TaskMcpService);
    const input = { endpoint, toolName: 'clawee_get_agent_health', token: 'test-account-secret', agentId: 'test-agent' };
    const failed = await checkEnterpriseMcpHealth(input);
    expect(failed.status).toBe('connection_failed');
    expect(JSON.stringify(failed)).not.toContain('private-secret');
    expect((await checkEnterpriseMcpHealth(input)).status).toBe('ready');
  });

  it('Gateway 网络失败与无效响应均不显示连接正常', async () => {
    const endpoint = await startServer({ getHealth: () => ({ arbitrary: 'private-secret' }) } as unknown as TaskMcpService);
    const input = { endpoint, toolName: 'clawee_get_agent_health', token: 'test-account-secret', agentId: 'test-agent' };
    expect((await checkEnterpriseMcpHealth(input)).status).toBe('unknown');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network failure: private-secret'));
    const result = await checkEnterpriseMcpHealth(input);
    expect(result.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });
});

async function startServer(service: TaskMcpService, rejectStatus?: number) {
  const server = Fastify();
  servers.push(server);
  server.addHook('onRequest', async (request, reply) => {
    if (rejectStatus !== undefined) return reply.code(rejectStatus).send();
    expect(request.headers.authorization).toBe('Bearer test-account-secret');
    expect(request.headers['x-claw-agent-id']).toBe('test-agent');
  });
  await registerTaskMcpRoutes(server, { service });
  return `${await server.listen({ host: '127.0.0.1', port: 0 })}/mcp`;
}
