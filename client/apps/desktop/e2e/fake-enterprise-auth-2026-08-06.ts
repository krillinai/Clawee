import { randomUUID } from 'node:crypto';
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer
} from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONTROLLED_MODEL_API_KEY } from './controlled-model-server.js';

export const desktopE2EEnterpriseEmail = 'desktop-e2e@example.com';
export const desktopE2EEnterprisePassword = 'desktop-e2e-password';

type FakeModelConfiguration = {
  baseUrl: string;
  model: string;
  apiKey: string;
};

const agentIdPattern =
  /^clawee_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FakeEnterpriseAuthServer {
  private server: Server | undefined;
  private readonly token = `desktop-e2e-${randomUUID()}`;
  private agentId: string | undefined;
  private modelConfiguration: FakeModelConfiguration | undefined;

  setModelOrigin(origin: string): void {
    this.setModelConfiguration({
      baseUrl: `${origin}/v1`,
      model: 'clawee-e2e-model',
      apiKey: CONTROLLED_MODEL_API_KEY
    });
  }

  setModelConfiguration(configuration: FakeModelConfiguration): void {
    this.modelConfiguration = { ...configuration };
  }

  async start(): Promise<string> {
    if (this.server !== undefined) {
      throw new Error('Fake enterprise auth server started twice');
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        sendJson(response, 500, {
          error: { code: 'fake_server_failed' }
        });
      });
    });
    await new Promise<void>((resolveStart, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolveStart());
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Fake enterprise auth server has no TCP address');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const current = this.server;
    this.server = undefined;
    if (current === undefined) return;
    current.closeIdleConnections();
    current.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => {
      current.close(error => {
        if (error) reject(error);
        else resolveClose();
      });
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const path = new URL(
      request.url ?? '/',
      'http://127.0.0.1'
    ).pathname;

    if (request.method === 'POST' && path === '/api/v1/auth/login') {
      const body = await readJsonBody(request);
      if (
        !isRecord(body)
        || body.email !== desktopE2EEnterpriseEmail
        || body.password !== desktopE2EEnterprisePassword
        || body.client_id !== 'clawee-agent'
        || typeof body.agent_id !== 'string'
        || !agentIdPattern.test(body.agent_id)
      ) {
        sendJson(response, 401, { error: { code: 'unauthorized' } });
        return;
      }
      this.agentId = body.agent_id;
      sendJson(response, 200, {
        data: {
          account: enterpriseAccount(),
          agent: enterpriseAgent(this.agentId),
          access_token: this.token,
          token_type: 'Bearer',
          expires_at: '2099-08-06T00:00:00.000Z'
        }
      });
      return;
    }

    if (request.headers.authorization !== `Bearer ${this.token}`) {
      sendJson(response, 401, { error: { code: 'unauthorized' } });
      return;
    }

    if (request.method === 'GET' && path === '/api/v1/auth/me') {
      if (this.agentId === undefined) {
        sendJson(response, 401, { error: { code: 'unauthorized' } });
        return;
      }
      sendJson(response, 200, {
        data: {
          account: enterpriseAccount(),
          agent: enterpriseAgent(this.agentId),
          applications: { frontend: true }
        }
      });
      return;
    }

    if (
      request.method === 'POST'
      && path === '/api/v1/app/agent-activity/events'
    ) {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        data: {
          accepted: true,
          received_events: isRecord(body) && Array.isArray(body.events)
            ? body.events.length
            : 0,
          server_time: new Date().toISOString()
        }
      });
      return;
    }

    if (request.method === 'GET' && path === '/api/v1/app/data-views') {
      sendJson(response, 200, {
        data: [{
          view_id: 'agent_activity',
          actions: ['read']
        }]
      });
      return;
    }

    if (
      request.method === 'POST'
      && path === '/api/v1/app/model-configuration'
    ) {
      if (this.modelConfiguration === undefined) {
        sendJson(response, 503, {
          error: { code: 'model_configuration_unavailable' }
        });
        return;
      }
      sendJson(response, 200, {
        data: {
          mode: 'platform_managed',
          base_url: this.modelConfiguration.baseUrl,
          model: this.modelConfiguration.model,
          api_key: this.modelConfiguration.apiKey,
          credential_version: 1
        }
      });
      return;
    }

    if (
      request.method === 'GET'
      && path === '/api/v1/app/business-data-sources/bilibili'
    ) {
      sendJson(response, 200, {
        data: { items: [{ source_id: 'bdsrc_packaged', status: 'active' }] }
      });
      return;
    }

    if (
      request.method === 'GET'
      && path === '/api/v1/app/business-dashboards/bilibili-operation'
    ) {
      sendJson(response, 200, bilibiliDashboardPayload());
      return;
    }

    if (request.method === 'POST' && path === '/api/v1/auth/logout') {
      response.statusCode = 204;
      response.end();
      return;
    }

    sendJson(response, 404, { error: { code: 'not_found' } });
  }
}

export function writeEnterpriseE2EConfig(
  path: string,
  gateway: string
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `gateway = ${JSON.stringify(gateway)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > 64 * 1024) throw new Error('Fake auth body is too large');
    chunks.push(value);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

function enterpriseAccount() {
  return {
    account_id: 'acct_desktop_e2e',
    email: desktopE2EEnterpriseEmail,
    name: 'Desktop E2E',
    status: 'active'
  };
}

function enterpriseAgent(agentId: string) {
  return {
    agent_id: agentId,
    name: 'Desktop E2E'
  };
}

function bilibiliDashboardPayload() {
  return {
    data: {
      status: 'available',
      data: {
        captured_at: '2026-08-30T01:30:00.000Z',
        follower_count: 128600,
        collected_content_count: 24,
        view_count: 8650000,
        interaction_count: 316800,
        top_contents: [{
          external_content_id: 'BV1packaged',
          title: '实际 App 新品内容复盘',
          captured_at: '2026-08-30T01:20:00.000Z',
          view_count: 680000,
          interaction_count: 28600
        }]
      }
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
