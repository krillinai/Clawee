import { describe, expect, it, vi } from 'vitest';
import { RuntimeClient } from '../runtime/client.js';
import { createWorkflowService } from './workflow-service.js';

describe('工作流客户端服务', () => {
  it('保留响应中的候选数组、角色和实际处理人', async () => {
    const data = { id: 'instance-1', nodes: [{ assignee_role_ids: ['r'], resolved_user_ids: ['a', 'b'] }], tasks: [{ assignee_user_ids: ['a', 'b'], handled_by: 'b' }] };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data }));
    const service = createWorkflowService(new RuntimeClient({ baseUrl: 'http://127.0.0.1:4317', fetchImpl: fetchMock }));
    await expect(service.instance('instance/1')).resolves.toEqual({ data });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4317/enterprise/workflow-instances/instance%2F1');
  });

  it('沿用 daemon camel 请求，不自行把候选缩减成首人', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: { instance_id: 'instance-1', task_id: 'task-1', status: 'running' } }));
    const service = createWorkflowService(new RuntimeClient({ baseUrl: 'http://127.0.0.1:4317', fetchImpl: fetchMock }));
    await service.start('template/1', { text: '内容' }, 'start-b');
    await service.decide('task/1', 'approve', '通过', 'decision-b');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:4317/enterprise/workflow-templates/template%2F1/instances', 'http://127.0.0.1:4317/enterprise/workflow-tasks/task%2F1/decision']);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ initialInput: { text: '内容' }, idempotencyKey: 'start-b' });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({ decision: 'approve', comment: '通过', idempotencyKey: 'decision-b' });
  });
});
