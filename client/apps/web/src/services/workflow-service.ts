import type { RuntimeClient } from '../runtime/client.js';
import type { EnterpriseWorkflowNode, EnterpriseWorkflowTemplate, EnterpriseWorkflowTask, EnterpriseWorkflowInstance, EnterpriseWorkflowResult } from '@clawee/protocol';

export type Node = EnterpriseWorkflowNode;
export type Template = EnterpriseWorkflowTemplate;
export type Task = EnterpriseWorkflowTask;
export type Instance = EnterpriseWorkflowInstance;
export type Page<T> = { data: T[]; meta: { next_cursor: string; has_next: boolean } };
export type Result = EnterpriseWorkflowResult;

export function createWorkflowService(client: Pick<RuntimeClient, 'get' | 'post'>) {
  return {
    templates: (cursor = '') => client.get<Page<Template>>(`/enterprise/workflow-templates?cursor=${encodeURIComponent(cursor)}`),
    template: (id: string) => client.get<{ data: Template }>(`/enterprise/workflow-templates/${encodeURIComponent(id)}`),
    start: (id: string, initialInput: Record<string, unknown>, idempotencyKey: string) => client.post<{ data: Result }>(`/enterprise/workflow-templates/${encodeURIComponent(id)}/instances`, { initialInput, idempotencyKey }),
    instances: (status: string, cursor = '') => client.get<Page<Instance>>(`/enterprise/workflow-instances?status=${encodeURIComponent(status)}&cursor=${encodeURIComponent(cursor)}`),
    instance: (id: string) => client.get<{ data: Instance }>(`/enterprise/workflow-instances/${encodeURIComponent(id)}`),
    tasks: (cursor = '') => client.get<Page<Task>>(`/enterprise/workflow-tasks?cursor=${encodeURIComponent(cursor)}`),
    decide: (id: string, decision: 'approve' | 'reject', comment: string, idempotencyKey: string) => client.post<{ data: Result }>(`/enterprise/workflow-tasks/${encodeURIComponent(id)}/decision`, { decision, comment, idempotencyKey }),
    prepare: (id: string, projectId: string) => client.post<{ threadId: string; instruction: string; input: string; firstNode: boolean }>(`/enterprise/workflow-tasks/${encodeURIComponent(id)}/prepare`, { projectId }),
    execute: (id: string, projectId: string, threadId: string, customInput: string, model?: string | null, reasoning?: string | null) => client.post<{ runId: string; threadId?: string; status: string }>(`/enterprise/workflow-tasks/${encodeURIComponent(id)}/execute`, { projectId, threadId, customInput, model, reasoning }),
    execution: (id: string) => client.get<{ status: string; runId?: string; runStatus?: string }>(`/enterprise/workflow-tasks/${encodeURIComponent(id)}/execution`),
    capability: () => client.get<{ canExecute: boolean }>('/enterprise/workflow-capability')
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
