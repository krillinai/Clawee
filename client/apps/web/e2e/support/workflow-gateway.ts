import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const workflowAccount = {
  account_id: 'acct_t03_workflow',
  email: 't03-workflow@example.test',
  name: 'T03 工作流账户',
  status: 'active'
};
export const otherWorkflowAccount = {
  ...workflowAccount,
  account_id: 'acct_t03_other',
  email: 't03-other@example.test',
  name: 'T03 其他账户'
};
export const workflowPassword = 't03-controlled-password';
export const workflowTemplate = {
  id: 'tpl_t03_controlled',
  name: 'T03 受控顺序流程',
  description: '仅模拟 Gateway 响应，不验证真实 Go 流转',
  status: 'enabled',
  revision: 1,
  nodes: [
    {
      node_id: 'node_t03_agent',
      order: 0,
      type: 'agent' as const,
      title: '生成待审核材料',
      instruction: '整理初始输入，等待用户主动执行',
      assignee_user_ids: [workflowAccount.account_id],
      resolved_user_ids: [workflowAccount.account_id]
    },
    {
      node_id: 'node_t03_approval',
      order: 1,
      type: 'approval' as const,
      title: '审核材料',
      instruction: '审核上一节点成果',
      assignee_user_ids: [workflowAccount.account_id],
      resolved_user_ids: [workflowAccount.account_id]
    }
  ]
};

type Identity = { account: typeof workflowAccount; agentId: string };
type StartRequest = {
  key: string;
  initialInput: Record<string, unknown>;
  subjectId: string;
  agentId: string;
};
type WorkflowTask = {
  task_id: string;
  instance_id: string;
  node_id: string;
  node_order: number;
  type: 'agent';
  status: 'pending';
  instruction: string;
  input: Record<string, unknown>;
  assignee_user_ids: string[];
};
type WorkflowInstance = {
  id: string;
  template_id: string;
  status: 'running';
  current_node_id: string;
  nodes: typeof workflowTemplate.nodes;
  started_at: string;
  tasks: WorkflowTask[];
  user_names: Record<string, string>;
};

export class ControlledWorkflowGateway {
  private server: Server | undefined;
  private readonly sessions = new Map<string, Identity>();
  private readonly starts = new Map<string, { request: StartRequest; instance: WorkflowInstance }>();
  private offline = false;
  private loseNextResponse = false;
  readonly startRequests: StartRequest[] = [];
  readonly unexpectedRequests: string[] = [];

  constructor(private readonly modelConfigured = true) {}

  get instances(): WorkflowInstance[] {
    return [...this.starts.values()].map(value => value.instance);
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
  }

  loseNextStartResponse(): void {
    this.loseNextResponse = true;
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      if (this.offline) {
        request.socket.destroy();
        return;
      }
      void this.handle(request, response).catch(() => {
        sendJson(response, 500, { error: { code: 'controlled_gateway_failed' } });
      });
    });
    await new Promise<void>((resolveStart, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolveStart);
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('受控 Gateway 未获得本地端口');
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'POST' && path === '/api/v1/auth/login') {
      const body = await readBody(request);
      const account = [workflowAccount, otherWorkflowAccount].find(value => value.email === body.email);
      if (!account || body.password !== workflowPassword || body.client_id !== 'clawee-agent'
        || typeof body.agent_id !== 'string'
        || !/^clawee_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.agent_id)) {
        sendJson(response, 401, { error: { code: 'unauthorized' } });
        return;
      }
      const token = randomUUID();
      this.sessions.set(token, { account, agentId: body.agent_id });
      sendJson(response, 200, {
        data: {
          account,
          agent: { agent_id: body.agent_id, name: 'T03 受控客户端' },
          access_token: token,
          token_type: 'Bearer',
          expires_at: '2099-10-09T00:00:00.000Z'
        }
      });
      return;
    }
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const identity = this.sessions.get(token);
    if (!identity || request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: { code: 'unauthorized' } });
      return;
    }
    if (request.method === 'GET' && path === '/api/v1/auth/me') {
      sendJson(response, 200, {
        data: {
          account: identity.account,
          agent: { agent_id: identity.agentId, name: 'T03 受控客户端' },
          applications: { frontend: true }
        }
      });
      return;
    }
    if (request.method === 'POST' && path === '/api/v1/auth/logout') {
      this.sessions.delete(token);
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'POST' && path === `/api/v1/app/workflow-templates/${workflowTemplate.id}/instances`) {
      const body = await readBody(request);
      if (identity.account.account_id !== workflowAccount.account_id) {
        sendJson(response, 403, { error: { code: 'forbidden' } });
        return;
      }
      if (typeof body.idempotency_key !== 'string' || !body.idempotency_key.length || body.idempotency_key.length > 200
        || !isRecord(body.initial_input)) {
        sendJson(response, 400, { error: { code: 'invalid_request' } });
        return;
      }
      const startRequest: StartRequest = {
        key: body.idempotency_key,
        initialInput: body.initial_input,
        subjectId: identity.account.account_id,
        agentId: identity.agentId
      };
      this.startRequests.push(startRequest);
      const scopedKey = `${identity.account.account_id}:${workflowTemplate.id}:${startRequest.key}`;
      let accepted = this.starts.get(scopedKey);
      if (accepted && JSON.stringify(accepted.request.initialInput) !== JSON.stringify(startRequest.initialInput)) {
        sendJson(response, 409, { error: { code: 'idempotency_conflict' } });
        return;
      }
      if (!accepted) {
        const id = `instance_${randomUUID()}`;
        const firstNode = workflowTemplate.nodes[0]!;
        accepted = {
          request: startRequest,
          instance: {
            id,
            template_id: workflowTemplate.id,
            status: 'running',
            current_node_id: firstNode.node_id,
            nodes: workflowTemplate.nodes,
            started_at: new Date().toISOString(),
            tasks: [{
              task_id: `task_${randomUUID()}`,
              instance_id: id,
              node_id: firstNode.node_id,
              node_order: 0,
              type: 'agent',
              status: 'pending',
              instruction: firstNode.instruction,
              input: startRequest.initialInput,
              assignee_user_ids: firstNode.assignee_user_ids
            }],
            user_names: { [workflowAccount.account_id]: workflowAccount.name }
          }
        };
        this.starts.set(scopedKey, accepted);
      }
      if (this.loseNextResponse) {
        this.loseNextResponse = false;
        response.destroy();
        return;
      }
      sendJson(response, 200, {
        data: {
          instance_id: accepted.instance.id,
          task_id: accepted.instance.tasks[0]!.task_id,
          status: 'running',
          next_task: accepted.instance.tasks[0]
        }
      });
      return;
    }
    const canView = identity.account.account_id === workflowAccount.account_id;
    if (request.method === 'GET' && path === '/api/v1/app/workflow-templates') {
      sendPage(response, canView ? [workflowTemplate] : []);
      return;
    }
    if (request.method === 'GET' && path === `/api/v1/app/workflow-templates/${workflowTemplate.id}` && canView) {
      sendJson(response, 200, { data: workflowTemplate });
      return;
    }
    if (request.method === 'GET' && path === '/api/v1/app/workflow-instances') {
      sendPage(response, canView ? this.instances : []);
      return;
    }
    if (request.method === 'GET' && path === '/api/v1/app/workflow-tasks') {
      sendPage(response, canView ? this.instances.flatMap(instance => instance.tasks) : []);
      return;
    }
    const instance = this.instances.find(value => path === `/api/v1/app/workflow-instances/${value.id}`);
    if (request.method === 'GET' && instance && canView) {
      sendJson(response, 200, { data: instance });
      return;
    }
    if (request.method === 'GET' && path === '/api/v1/app/platform-branding') {
      sendJson(response, 200, { data: { sidebar_logo_configured: false, sidebar_compact_logo_configured: false } });
      return;
    }
    if (request.method === 'POST' && path === '/api/v1/app/model-configuration') {
      if (!this.modelConfigured) {
        sendJson(response, 200, { data: { mode: 'enterprise_managed' } });
        return;
      }
      sendJson(response, 200, { data: {
        mode: 'platform_managed', base_url: 'https://model.example.test/v1', model: 'clawee-web-e2e-model',
        api_key: 'clawee-web-e2e-key', credential_version: 1
      } });
      return;
    }
    if (request.method === 'GET' && path === '/api/v1/app/mcp/catalog') {
      sendJson(response, 200, { data: { upstreams: [] } });
      return;
    }
    if (request.method === 'POST' && path === '/api/v1/app/agent-activity/events') {
      const body = await readBody(request);
      sendJson(response, 200, { data: {
        accepted: true, received_events: Array.isArray(body.events) ? body.events.length : 0,
        server_time: new Date().toISOString()
      } });
      return;
    }
    if (request.method === 'GET' && path === '/api/v1/app/data-views') {
      sendJson(response, 200, { data: [] });
      return;
    }
    if (path !== '/api/v1/app/mcp/token/reveal') this.unexpectedRequests.push(`${request.method} ${path}`);
    sendJson(response, 404, { error: { code: 'not_found' } });
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function sendPage(response: ServerResponse, data: unknown[]): void {
  sendJson(response, 200, { data, meta: { next_cursor: '', has_next: false } });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024 + 8192) throw new Error('受控请求过大');
    chunks.push(Buffer.from(chunk));
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isRecord(body)) throw new Error('受控请求必须为 JSON 对象');
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
