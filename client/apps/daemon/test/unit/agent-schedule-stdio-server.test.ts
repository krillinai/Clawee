import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentScheduleMcpServer } from '../../src/agent-tools/stdio-server.js';

let closeWork: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closeWork.map(close => close()));
  closeWork = [];
});

describe('agent schedule MCP server', () => {
  it('exposes workflow files only for an explicit grant and rejects arbitrary spaces', async () => {
    const request = vi.fn(async () => ({ artifact: { file_id: 'file-1' } }));
    const server = createAgentScheduleMcpServer({ request, enabledTools: ['clawee_workflow_upload_file', 'clawee_workflow_read_file'] });
    const client = new Client({ name: 'workflow-files-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeWork.push(() => client.close(), () => server.close());
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['clawee_workflow_upload_file', 'clawee_workflow_read_file']);
    const uploaded = await client.callTool({ name: 'clawee_workflow_upload_file', arguments: { path: 'output/report.txt' } });
    expect(uploaded.isError).not.toBe(true);
    expect(request).toHaveBeenCalledWith({ method: 'POST', path: '/internal/agent-tools/workflow/files/upload', body: { path: 'output/report.txt' } });
    request.mockClear();
    const forged = await client.callTool({ name: 'clawee_workflow_upload_file', arguments: { path: 'output/report.txt', spaceId: 'other' } });
    expect(forged.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('registers all schedule tools and executes structured create input', async () => {
    const request = vi.fn(async () => ({
      id: 'schedule-1',
      threadId: 'thread-1',
      name: '每日总结',
      enabled: true,
      nextRunAt: '2026-07-15T10:00:00.000Z'
    }));
    const server = createAgentScheduleMcpServer({
      request,
      defaultTimezone: 'UTC'
    });
    const client = new Client({
      name: 'clawee-agent-test',
      version: '0.1.0'
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeWork.push(() => client.close(), () => server.close());

    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'clawee_schedule_create',
      'clawee_schedule_update',
      'clawee_schedule_pause',
      'clawee_schedule_resume',
      'clawee_schedule_run_now',
      'clawee_schedule_get'
    ]);

    const result = await client.callTool({
      name: 'clawee_schedule_create',
      arguments: {
        name: '每日总结',
        task: '总结今天的工作',
        timing: { type: 'daily', time: '18:00' },
        timezone: 'Asia/Shanghai'
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      scheduleId: 'schedule-1',
      threadId: 'thread-1',
      name: '每日总结',
      enabled: true,
      nextRunAt: '2026-07-15T10:00:00.000Z'
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      path: '/internal/agent-tools/schedules'
    }));
  });

  it('rejects unknown fields before the internal api is called', async () => {
    const request = vi.fn();
    const server = createAgentScheduleMcpServer({
      request,
      defaultTimezone: 'UTC'
    });
    const client = new Client({
      name: 'clawee-agent-test',
      version: '0.1.0'
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeWork.push(() => client.close(), () => server.close());

    const result = await client.callTool({
      name: 'clawee_schedule_create',
      arguments: {
        name: '伪造任务',
        task: '内容',
        timing: { type: 'daily', time: '09:00' },
        threadId: 'thread-forged'
      }
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('registers only tools enabled for the active process grant', async () => {
    const server = createAgentScheduleMcpServer({
      request: vi.fn(),
      enabledTools: [
        'clawee_schedule_update',
        'clawee_schedule_get'
      ]
    });
    const client = new Client({
      name: 'clawee-agent-test',
      version: '0.1.0'
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeWork.push(() => client.close(), () => server.close());

    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'clawee_schedule_update',
      'clawee_schedule_get'
    ]);
  });
});
