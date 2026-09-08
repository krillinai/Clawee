import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { MCP_CHAIN_TIMEOUT_MS } from '../task-mcp/constants.js';
import { createTaskMcpServer } from '../task-mcp/server.js';
import type { TaskMcpService } from '../task-mcp/service.js';

export async function registerTaskMcpRoutes(
  fastify: FastifyInstance,
  input: {
    service: TaskMcpService;
  }
): Promise<void> {
  const activeRequests = new Set<() => Promise<void>>();

  fastify.post<{ Body: unknown }>('/mcp', async (request, reply) => {
    request.raw.setTimeout(MCP_CHAIN_TIMEOUT_MS);
    reply.header('Cache-Control', 'no-cache, no-transform');
    reply.header('X-Accel-Buffering', 'no');
    enforceMcpResponseHeaders(reply.raw);

    const mcpServer = createTaskMcpServer(input);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    let cleanupWork: Promise<void> | undefined;
    const cleanup = () => {
      cleanupWork ??= Promise.allSettled([
        transport.close(),
        mcpServer.close()
      ]).then(() => {
        activeRequests.delete(cleanup);
      });
      return cleanupWork;
    };
    activeRequests.add(cleanup);
    reply.raw.once('finish', () => void cleanup());
    reply.raw.once('close', () => void cleanup());
    reply.hijack();

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, {
          'content-type': 'application/json',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no'
        });
        reply.raw.end(JSON.stringify(jsonRpcError('Internal MCP server error')));
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
      await cleanup();
    }
  });

  fastify.get('/mcp', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-cache, no-transform')
      .header('X-Accel-Buffering', 'no')
      .code(405)
      .send(jsonRpcError('Method not allowed')));
  fastify.delete('/mcp', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-cache, no-transform')
      .header('X-Accel-Buffering', 'no')
      .code(405)
      .send(jsonRpcError('Method not allowed')));

  fastify.addHook('preClose', async () => {
    await Promise.allSettled([...activeRequests].map(cleanup => cleanup()));
  });
}

function enforceMcpResponseHeaders(response: ServerResponse): void {
  const writeHead = response.writeHead.bind(response);
  response.writeHead = (function (
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders,
    headers?: OutgoingHttpHeaders
  ) {
    const statusMessage = typeof statusMessageOrHeaders === 'string'
      ? statusMessageOrHeaders
      : undefined;
    const suppliedHeaders = typeof statusMessageOrHeaders === 'string'
      ? headers
      : statusMessageOrHeaders;
    const mergedHeaders: OutgoingHttpHeaders = { ...suppliedHeaders };
    for (const name of Object.keys(mergedHeaders)) {
      if (name.toLowerCase() === 'cache-control') delete mergedHeaders[name];
      if (name.toLowerCase() === 'x-accel-buffering') delete mergedHeaders[name];
    }
    mergedHeaders['Cache-Control'] = 'no-cache, no-transform';
    mergedHeaders['X-Accel-Buffering'] = 'no';
    return statusMessage === undefined
      ? writeHead(statusCode, mergedHeaders)
      : writeHead(statusCode, statusMessage, mergedHeaders);
  }) as typeof response.writeHead;
}

function jsonRpcError(message: string) {
  return {
    jsonrpc: '2.0',
    error: { code: -32603, message },
    id: null
  };
}
