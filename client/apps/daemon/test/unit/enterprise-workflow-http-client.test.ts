import { describe, expect, it, vi } from 'vitest';
import { createEnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';

const origin = 'https://enterprise.example';
const node = { node_id: 'review', order: 0, type: 'approval', title: '审核', instruction: '审核', assignee_user_id: 'a' };
const task = { task_id: 'task-1', instance_id: 'instance-1', node_id: 'review', type: 'approval', status: 'pending', instruction: '审核', input: { text: '内容' }, assignee_user_id: 'a' };
const meta = { next_cursor: '', has_next: false };

describe('企业工作流响应校验', () => {
  it('兼容旧单账户模板及任务，并保留新候选快照', async () => {
    const sharedTask = { ...task, assignee_user_ids: ['a', 'b'], handled_by: 'b' };
    const instance = { id: 'instance-1', template_id: 'template-1', status: 'running', started_at: '2026-09-30T00:00:00Z', nodes: [{ ...node, assignee_user_ids: ['a'], assignee_role_ids: ['reviewers'], resolved_user_ids: ['a', 'b'] }], tasks: [sharedTask], user_names: { a: '张三', b: '李四' } };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'template-1', name: '审核', description: '', status: 'enabled', revision: 1, nodes: [node] }], meta }))
      .mockResolvedValueOnce(Response.json({ data: task }))
      .mockResolvedValueOnce(Response.json({ data: instance }))
      .mockResolvedValueOnce(Response.json({ data: [sharedTask], meta }));
    const http = createEnterpriseHttpClient({ origin, fetch: fetchMock });
    await expect(http.workflowRequest!('token', 'GET', '/api/v1/app/workflow-templates')).resolves.toMatchObject({ data: [{ nodes: [node] }] });
    await expect(http.workflowRequest!('token', 'GET', '/api/v1/app/workflow-tasks/task-1')).resolves.toEqual({ data: task, meta: undefined });
    await expect(http.workflowRequest!('token', 'GET', '/api/v1/app/workflow-instances/instance-1')).resolves.toEqual({ data: instance, meta: undefined });
    await expect(http.workflowRequest!('token', 'GET', '/api/v1/app/workflow-tasks?cursor=')).resolves.toEqual({ data: [sharedTask], meta });
    expect(fetchMock.mock.calls.every(([, request]) => (request?.headers as Record<string, string>).Authorization === 'Bearer token')).toBe(true);
  });

  it('允许仅角色模板且不制造首账户负责人', async () => {
    const roleNode = { ...node, assignee_user_id: '', assignee_user_ids: [], assignee_role_ids: ['reviewers'] };
    const data = { id: 'template-1', name: '审核', description: '', status: 'enabled', revision: 1, nodes: [roleNode] };
    const http = createEnterpriseHttpClient({ origin, fetch: vi.fn(async () => Response.json({ data })) });
    await expect(http.workflowRequest!('token', 'GET', '/api/v1/app/workflow-templates/template-1')).resolves.toMatchObject({ data: { nodes: [roleNode] } });
  });

  it.each([{ assignee_user_ids: 'a' }, { assignee_user_ids: ['a', 1] }, { input: [] }, { input: null }])('拒绝非法候选或输入响应 %j', async (invalid) => {
    const http = createEnterpriseHttpClient({ origin, fetch: vi.fn(async () => Response.json({ data: { ...task, ...invalid } })) });
    await expect(http.workflowRequest!('token', 'GET', '/api/v1/app/workflow-tasks/task-1')).rejects.toMatchObject({ code: 'ENTERPRISE_PROTOCOL_ERROR' });
  });

  it('保留完成结果中的下一节点全体候选', async () => {
    const data = { instance_id: 'instance-1', task_id: 'task-1', status: 'running', next_task: { ...task, task_id: 'next', assignee_user_ids: ['b', 'c'] } };
    const http = createEnterpriseHttpClient({ origin, fetch: vi.fn(async () => Response.json({ data })) });
    await expect(http.workflowRequest!('token', 'POST', '/api/v1/app/workflow-tasks/task-1/decision', { decision: 'approve', idempotency_key: 'key' })).resolves.toEqual({ data, meta: undefined });
  });

  it.each([['b'], ['b', 'c']])('解析真实完成摘要 input:null 和同人幂等历史响应，保留候选 %j', async (...assignees) => {
    const data = { instance_id: 'instance-1', task_id: 'task-1', status: 'running', next_task: { task_id: 'next', instance_id: 'instance-1', node_id: 'next-node', node_order: 1, type: 'agent', status: 'pending', instruction: '执行下一步', assignee_user_id: assignees[0], assignee_user_ids: assignees, input: null } };
    const storedResponse = JSON.stringify({ data });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(storedResponse, { headers: { 'Content-Type': 'application/json' } }));
    const http = createEnterpriseHttpClient({ origin, fetch: fetchMock });
    const request = { decision: 'approve', comment: '', idempotency_key: 'same-user-key' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(http.workflowRequest!('token', 'POST', '/api/v1/app/workflow-tasks/task-1/decision', request)).resolves.toEqual({ data, meta: undefined });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('真实任务列表仍拒绝 input:null', async () => {
    const http = createEnterpriseHttpClient({ origin, fetch: vi.fn(async () => Response.json({ data: [{ ...task, input: null }], meta })) });
    await expect(http.workflowRequest!('token', 'GET', '/api/v1/app/workflow-tasks')).rejects.toMatchObject({ code: 'ENTERPRISE_PROTOCOL_ERROR', stage: 'decode', statusCode: 200 });
  });
});
