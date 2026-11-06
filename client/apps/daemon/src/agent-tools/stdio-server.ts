import { createDriveToolDefinitions, type AgentDriveToolName } from './drive-tools.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import {
  AGENT_TOOL_BASE_URL_ENV,
  AGENT_TOOL_CAPABILITY_TOKEN_ENV
} from './run-injection.js';
import {
  createAgentScheduleHttpClient,
  createAgentScheduleToolDefinitions,
  type AgentScheduleToolName
} from './schedule-tools.js';
import { createWorkflowToolDefinitions, type AgentWorkflowToolName } from './workflow-tools.js';
import { createSkillToolDefinitions, type AgentSkillToolName } from './skill-tools.js';

export async function startAgentScheduleStdioServer(
  env: NodeJS.ProcessEnv = process.env
): Promise<McpServer> {
  const baseUrl = requireEnvironment(env, AGENT_TOOL_BASE_URL_ENV);
  const token = requireEnvironment(env, AGENT_TOOL_CAPABILITY_TOKEN_ENV);
  const client = createAgentScheduleHttpClient({ baseUrl, token });
  const grant = await client.request({ method: 'GET', path: '/internal/agent-tools/capabilities' }) as { tools: Array<AgentScheduleToolName | AgentWorkflowToolName | AgentSkillToolName | AgentDriveToolName> };
  const server = createAgentScheduleMcpServer({ request: request => client.request(request), enabledTools: grant.tools });
  await server.connect(new StdioServerTransport());
  return server;
}

export function createAgentScheduleMcpServer(input: {
  request: ReturnType<typeof createAgentScheduleHttpClient>['request'];
  defaultTimezone?: string;
  enabledTools?: Array<AgentScheduleToolName | AgentWorkflowToolName | AgentSkillToolName | AgentDriveToolName>;
}): McpServer {
  const scheduleTools = createAgentScheduleToolDefinitions({
    request: input.request,
    defaultTimezone: input.defaultTimezone
  });
  const tools = { ...scheduleTools, ...createWorkflowToolDefinitions(input.request), ...createSkillToolDefinitions(input.request), ...createDriveToolDefinitions(input.request) };
  const server = new McpServer({
    name: 'clawee-schedule-tools',
    version: '0.1.0'
  });

  const enabledTools = new Set<string>(input.enabledTools ?? Object.keys(scheduleTools));
  for (const [name, tool] of Object.entries(tools)) {
    if (
      !enabledTools.has(name)
    ) {
      continue;
    }
    server.registerTool(name, {
      description: tool.description,
      inputSchema: tool.inputSchema
    }, async (args: unknown): Promise<CallToolResult> => {
      try {
        const result = await tool.execute(args);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result)
          }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: error instanceof Error
              ? error.message
              : 'Clawee schedule tool failed'
          }]
        };
      }
    });
  }
  return server;
}

function requireEnvironment(
  env: NodeJS.ProcessEnv,
  name: string
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error('Clawee schedule tool environment is incomplete');
  }
  return value;
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startAgentScheduleStdioServer().catch(() => {
    console.error('Clawee schedule MCP server failed to start');
    process.exitCode = 1;
  });
}
