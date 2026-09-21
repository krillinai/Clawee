import { adminApi } from "./api";

export type WorkflowNode = { node_id: string; order: number; type: "agent" | "approval"; title: string; assignee_user_id: string; instruction: string };
export type WorkflowAssignee = { user_id: string; name: string; email: string };
export type WorkflowTemplate = { id: string; name: string; description: string; status: "draft" | "enabled" | "disabled"; revision: number; nodes: WorkflowNode[]; created_at: string };
export type WorkflowTask = { task_id: string; node_id: string; status: string; assignee_user_id: string; input: Record<string, unknown>; output?: Record<string, unknown>; decision?: string; comment?: string; handled_by?: string; completed_at?: string };
export type WorkflowInstance = { id: string; template_id: string; template_revision: number; nodes: WorkflowNode[]; status: string; current_node_id?: string; started_by: string; started_at: string; tasks?: WorkflowTask[] };
type Page<T> = { items: T[]; meta: { next_cursor: string } };

export const workflowAdmin = {
  assignees: (query = "") => adminApi.get<Page<WorkflowAssignee>>(`/workflow-assignees?q=${encodeURIComponent(query)}`),
  templates: (cursor = "") => adminApi.get<Page<WorkflowTemplate>>(`/workflow-templates?limit=20&cursor=${encodeURIComponent(cursor)}`),
  template: (id: string) => adminApi.get<WorkflowTemplate>(`/workflow-templates/${encodeURIComponent(id)}`),
  save: (item: Pick<WorkflowTemplate, "name" | "description" | "nodes"> & { id?: string; expected_revision: number }) =>
    item.id ? adminApi.put<WorkflowTemplate>(`/workflow-templates/${encodeURIComponent(item.id)}`, item) : adminApi.post<WorkflowTemplate>("/workflow-templates", item),
  status: (id: string, enabled: boolean) => adminApi.post<WorkflowTemplate>(`/workflow-templates/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`),
  instances: (status: string, cursor = "") => adminApi.get<Page<WorkflowInstance>>(`/workflow-instances?status=${encodeURIComponent(status)}&limit=20&cursor=${encodeURIComponent(cursor)}`),
  instance: (id: string) => adminApi.get<WorkflowInstance>(`/workflow-instances/${encodeURIComponent(id)}`),
  terminate: (id: string, reason: string) => adminApi.post<WorkflowInstance>(`/workflow-instances/${encodeURIComponent(id)}/terminate`, { reason })
};
