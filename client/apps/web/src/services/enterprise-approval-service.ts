import type { EnterpriseApprovalDetail, EnterpriseApprovalFile, EnterpriseApprovalFilters, EnterpriseApprovalKind, EnterpriseApprovalPage, EnterpriseApprovalTrial, EnterpriseReviewScores } from '@clawee/protocol';
import type { RuntimeClient } from '../runtime/client.js';
import { createWorkflowService } from './workflow-service.js';

export function createEnterpriseApprovalService(client: Pick<RuntimeClient, 'get' | 'post'>) {
  return {
    list: (filters: EnterpriseApprovalFilters, signal?: AbortSignal) => client.get<EnterpriseApprovalPage>(`/enterprise/approvals?${new URLSearchParams({ ...filters, cursor: filters.cursor ?? '' })}`, { signal }),
    detail: (kind: EnterpriseApprovalKind, id: string, signal?: AbortSignal) => client.get<{ data: EnterpriseApprovalDetail }>(`/enterprise/approvals/${kind}/${encodeURIComponent(id)}`, { signal }),
    skillDecision: (id: string, input: { decision: 'approved' | 'rejected'; comment: string; scores: EnterpriseReviewScores }) => client.post(`/enterprise/approvals/skill/${encodeURIComponent(id)}/decision`, input),
    workflowDecision: createWorkflowService(client).decide,
    files: (id: string, signal?: AbortSignal) => client.get<{ items: EnterpriseApprovalFile[] }>(`/enterprise/approvals/skill/${encodeURIComponent(id)}/files`, { signal }),
    file: (id: string, path: string, signal?: AbortSignal) => client.get<{ data: EnterpriseApprovalFile & { content: string } }>(`/enterprise/approvals/skill/${encodeURIComponent(id)}/file?${new URLSearchParams({ path })}`, { signal }),
    trial: (id: string, projectId: string) => client.post<EnterpriseApprovalTrial>(`/enterprise/approvals/skill/${encodeURIComponent(id)}/trial`, { projectId })
  };
}
export type EnterpriseApprovalService = ReturnType<typeof createEnterpriseApprovalService>;
