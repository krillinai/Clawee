import type { EnterpriseMcpHealthResponse } from '@clawee/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

const healthSchema = z.object({
  runtime: z.enum(['ready', 'unavailable', 'unknown']),
  model: z.enum(['configured', 'configuration_required', 'unknown'])
});

export async function checkEnterpriseMcpHealth(input: {
  endpoint: string;
  toolName: string;
  token: string;
  agentId: string;
}): Promise<EnterpriseMcpHealthResponse> {
  const client = new Client({ name: 'clawee-agent-health', version: '1.0.0' });
  const signal = AbortSignal.timeout(10_000);
  const transport = new StreamableHTTPClientTransport(new URL(input.endpoint), {
    requestInit: {
      headers: { Authorization: `Bearer ${input.token}`, 'X-Claw-Agent-ID': input.agentId }
    },
    fetch: (url, init) => globalThis.fetch(url, {
      ...init,
      redirect: 'error',
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal
    }),
    reconnectionOptions: {
      maxRetries: 0, maxReconnectionDelay: 1000,
      initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1
    }
  });
  const result = (status: EnterpriseMcpHealthResponse['status'], message: string): EnterpriseMcpHealthResponse => ({
    status, message, checkedAt: new Date().toISOString()
  });
  try {
    await client.connect(transport, { signal });
    const tools = await client.listTools({}, { signal });
    if (!tools.tools.some(tool => tool.name === input.toolName)) {
      return result('attention', '健康检查工具不可用，请管理员核对工具启用状态和当前账号权限');
    }
    const response = await client.callTool({ name: input.toolName, arguments: {} }, undefined, { signal });
    if (response.isError) {
      const errorText = (response.content as Array<{ type: string; text?: string }>)
        .filter(item => item.type === 'text').map(item => item.text ?? '').join(' ');
      if (/not granted|not active|unauthorized|forbidden|permission|not available on endpoint/i.test(errorText)) {
        return result('attention', '健康查询未获授权，请管理员检查账号权限及上游凭据');
      }
      return result('connection_failed', 'Gateway 无法完成 Agent 健康查询，请管理员检查服务及连接');
    }
    const parsed = healthSchema.safeParse(response.structuredContent);
    if (!parsed.success) {
      return result('unknown', '未取得有效健康状态，请管理员检查 Agent 版本及健康工具配置');
    }
    const checks = parsed.data;
    if (checks.runtime === 'unavailable') {
      return { ...result('attention', 'Runtime 未就绪，请管理员检查服务端 Runtime'), checks };
    }
    if (checks.model === 'configuration_required') {
      return { ...result('attention', '模型配置未就绪，请管理员在服务端配置并验证模型'), checks };
    }
    if (checks.runtime === 'unknown' || checks.model === 'unknown') {
      return { ...result('unknown', 'MCP 连接正常，部分执行条件尚未确认'), checks };
    }
    return { ...result('ready', 'MCP 连接正常，Runtime 和模型配置已准备；实际执行以任务结果为准'), checks };
  } catch (error) {
    if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
      return result('attention', 'MCP 身份验证或授权失败，请检查账号令牌和 Agent 权限');
    }
    if (error instanceof StreamableHTTPError && error.code === 404) {
      return result('attention', '企业 MCP 入口不可用，请管理员检查服务是否启用');
    }
    return result('unknown', '无法连接企业 Gateway 或检查超时，请检查网络后重试');
  } finally {
    await client.close().catch(() => undefined);
  }
}
