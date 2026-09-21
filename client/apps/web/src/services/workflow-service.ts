import type { RuntimeClient } from '../runtime/client.js';

export type Node = { node_id: string; order: number; type: 'agent' | 'approval'; title: string; assignee_user_id: string; instruction: string };
export type Template = { id: string; name: string; description: string; status: string; revision: number; nodes: Node[] };
export type Task = { task_id: string; instance_id: string; node_id: string; type: 'agent' | 'approval'; status: string; assignee_user_id: string; instruction: string; input: Record<string, unknown>; output?: Record<string, unknown>; decision?: string; comment?: string };
export type Instance = { id: string; template_id: string; status: string; current_node_id?: string; nodes: Node[]; tasks?: Task[]; started_at: string };
export type Page<T> = { data: T[]; meta: { next_cursor: string; has_next: boolean } };
export type Result = { instance_id: string; task_id: string; status: string };

export function createWorkflowService(client: Pick<RuntimeClient, 'get' | 'post'>) {
  return {
    templates: (cursor = '') => client.get<Page<Template>>(`/enterprise/workflow-templates?cursor=${encodeURIComponent(cursor)}`),
    template: (id: string) => client.get<{ data: Template }>(`/enterprise/workflow-templates/${encodeURIComponent(id)}`),
    start: (id: string, initialInput: Record<string, unknown>, idempotencyKey: string) => client.post<{ data: Result }>(`/enterprise/workflow-templates/${encodeURIComponent(id)}/instances`, { initialInput, idempotencyKey }),
    instances: (status: string, cursor = '') => client.get<Page<Instance>>(`/enterprise/workflow-instances?status=${encodeURIComponent(status)}&cursor=${encodeURIComponent(cursor)}`),
    instance: (id: string) => client.get<{ data: Instance }>(`/enterprise/workflow-instances/${encodeURIComponent(id)}`),
    tasks: (cursor = '') => client.get<Page<Task>>(`/enterprise/workflow-tasks?cursor=${encodeURIComponent(cursor)}`),
    decide: (id: string, decision: 'approve' | 'reject', comment: string, idempotencyKey: string) => client.post<{ data: Result }>(`/enterprise/workflow-tasks/${encodeURIComponent(id)}/decision`, { decision, comment, idempotencyKey }),
    execute: (id: string, cwd: string) => client.post<{ runId: string; status: string }>(`/enterprise/workflow-tasks/${encodeURIComponent(id)}/execute`, { cwd }),
    execution: (id: string) => client.get<{ status: string; runId?: string; runStatus?: string }>(`/enterprise/workflow-tasks/${encodeURIComponent(id)}/execution`),
    capability: () => client.get<{ canExecute: boolean }>('/enterprise/workflow-capability')
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
