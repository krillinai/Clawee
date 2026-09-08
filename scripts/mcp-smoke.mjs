import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../client/apps/daemon/package.json', import.meta.url));
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// 只由创建全新隔离 Gateway 的容器验收脚本调用。
export async function verifyMcpPermissions(origin, adminCookies, userId, agentId) {
  let calls = 0;
  const upstream = createServer(async (request, response) => {
    const server = new McpServer({ name: 'clawee-smoke-upstream', version: '1.0.0' });
    server.registerTool('echo', { description: '返回验收标记', inputSchema: {} }, async () => {
      calls++;
      return { content: [{ type: 'text', text: 'CLAWEE-MCP-OK' }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise(resolve => upstream.listen(0, '0.0.0.0', resolve));
  const client = new Client({ name: 'clawee-smoke-client', version: '1.0.0' });
  async function api(path, method = 'GET', payload, status = 200) {
    const response = await fetch(origin + '/api/v1/admin/mcp/' + path, {
      method, headers: { Cookie: adminCookies, 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000)
    });
    assert.equal(response.status, status, `${path} HTTP ${response.status}`);
    if (status === 204) return;
    return (await response.json()).data;
  }
  try {
    await api('upstream-servers', 'POST', {
      server_id: 'smoke-upstream', name: 'Smoke', domain: 'smoke', namespace: 'smoke',
      transport: 'streamable_http', endpoint: `http://host.docker.internal:${upstream.address().port}/mcp`, status: 'active'
    }, 201);
    await api('upstream-servers/sync-tools', 'POST', { server_id: 'smoke-upstream' });
    const capabilities = await api('capabilities?server_id=smoke-upstream');
    const capability = capabilities.find(item => item.upstream_name === 'echo');
    assert.ok(capability, '上游能力已同步');
    await api('capabilities', 'PATCH', { capability_id: capability.id, status: 'active' });
    const token = await api('accounts/token/rotate', 'POST', { user_id: userId, scopes: ['mcp:call'] });
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token.token}`, 'X-Claw-Agent-ID': agentId } }
    }));
    const listed = () => client.listTools();
    const invoke = () => client.callTool({ name: capability.exposed_name, arguments: {} });
    async function expectDenied() {
      assert.equal((await listed()).tools.some(tool => tool.name === capability.exposed_name), false);
      let denied = false;
      try { denied = (await invoke()).isError === true; } catch { denied = true; }
      assert.equal(denied, true, '未授权调用必须失败');
    }
    await expectDenied();
    assert.equal(calls, 0);
    const grant = await api('grants', 'POST', { user_id: userId, capability_id: capability.id, grant_type: 'tool' }, 201);
    assert.equal((await listed()).tools.some(tool => tool.name === capability.exposed_name), true);
    const result = await invoke();
    assert.notEqual(result.isError, true);
    assert.ok(result.content.some(item => item.type === 'text' && item.text.includes('CLAWEE-MCP-OK')));
    assert.equal(calls, 1);
    await api('grants/remove', 'POST', { grant_id: grant.id }, 204);
    await expectDenied();
    assert.equal(calls, 1, '撤销后请求不得到达上游');
    console.log('MCP 验证通过：能力同步、账号授权、实际转发、撤销及未授权请求隔离。');
  } finally {
    await client.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
}
