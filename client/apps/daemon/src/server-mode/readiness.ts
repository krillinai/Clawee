import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const REQUIRED_TASK_TOOLS = [
  'clawee_submit_task',
  'clawee_get_task',
  'clawee_get_task_result'
] as const;

export type ServerReadinessChecks = {
  health: 'ok';
  web: 'ok';
  runtimeApi: 'ok';
  mcp: 'ok';
  codexRuntime: 'ok';
};

export async function checkServerReadiness(input: {
  address: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}): Promise<ServerReadinessChecks> {
  const fetch = input.fetch ?? globalThis.fetch;
  const baseUrl = reachableBaseUrl(input.address);
  await checkResponse(
    fetch(new URL('/healthz', baseUrl)),
    'SERVER_HEALTH_CHECK_FAILED'
  );

  const web = await checkResponse(
    fetch(new URL('/', baseUrl)),
    'SERVER_WEB_CHECK_FAILED'
  );
  if (!web.headers.get('content-type')?.toLowerCase().includes('text/html')) {
    throw new Error('SERVER_WEB_CHECK_FAILED');
  }

  const runtimeConfig = await checkResponse(
    fetch(new URL('/.clawee/runtime-config', baseUrl)),
    'SERVER_RUNTIME_CONFIG_CHECK_FAILED'
  );
  let runtimeConfigBody: unknown;
  try {
    runtimeConfigBody = await runtimeConfig.json();
  } catch {
    throw new Error('SERVER_RUNTIME_CONFIG_CHECK_FAILED');
  }
  if (
    !isRecord(runtimeConfigBody)
    || runtimeConfigBody.baseUrl !== ''
    || runtimeConfigBody.token !== input.token
  ) {
    throw new Error('SERVER_RUNTIME_CONFIG_CHECK_FAILED');
  }

  await checkResponse(fetch(new URL('/projects', baseUrl), {
    headers: { Authorization: `Bearer ${input.token}` }
  }), 'SERVER_RUNTIME_API_CHECK_FAILED');
  await checkMcp(baseUrl, input.token, fetch);

  return {
    health: 'ok',
    web: 'ok',
    runtimeApi: 'ok',
    mcp: 'ok',
    codexRuntime: 'ok'
  };
}

async function checkMcp(
  baseUrl: URL,
  token: string,
  fetch: typeof globalThis.fetch
): Promise<void> {
  const transport = new StreamableHTTPClientTransport(
    new URL('/mcp', baseUrl),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch
    }
  );
  const client = new Client({
    name: 'clawee-server-readiness',
    version: '1.0.0'
  });
  try {
    try {
      await client.connect(transport);
    } catch {
      throw new Error('SERVER_MCP_INITIALIZE_FAILED');
    }
    let tools;
    try {
      tools = await client.listTools();
    } catch {
      throw new Error('SERVER_MCP_TOOLS_CHECK_FAILED');
    }
    assertRequiredTaskTools(tools.tools.map(tool => tool.name));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function assertRequiredTaskTools(names: readonly string[]): void {
  const actual = [...names].sort();
  const expected = [...REQUIRED_TASK_TOOLS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('SERVER_MCP_TOOLS_CHECK_FAILED');
  }
}

async function checkResponse(
  responseWork: Promise<Response>,
  code: string
): Promise<Response> {
  let response: Response;
  try {
    response = await responseWork;
  } catch {
    throw new Error(code);
  }
  if (response.status !== 200) throw new Error(code);
  return response;
}

function reachableBaseUrl(address: string): URL {
  const url = new URL(address);
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  if (url.hostname === '[::]' || url.hostname === '::') url.hostname = '[::1]';
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
