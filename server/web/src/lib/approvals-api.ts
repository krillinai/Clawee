import { appApi } from "./api";
import { mapSkillDetail, type AdminSkillDetailResponse, type SkillReviewScores, type SkillVersionFile, type SkillVersionFileContent } from "./skillhub-api";
import type { WorkflowInstance, WorkflowTask } from "./workflow-api";

export type ApprovalKind = "skill" | "workflow" | "workflow_instance";
export type ApprovalView = "todo" | "done" | "initiated";
export type ApprovalType = "all" | "skill" | "workflow";
export type ApprovalStatus = "all" | "pending" | "approved" | "rejected" | "invalidated" | "running" | "succeeded" | "terminated";
export type ApprovalItem = {
  kind: ApprovalKind;
  id: string;
  type: "skill" | "workflow";
  title: string;
  business_status: string;
  my_status: "pending" | "approved" | "rejected" | "";
  created_at: string;
  can_process: boolean;
  acted_at?: string;
  initiated_by?: string;
  skill_id?: string;
  version_id?: string;
  version?: string;
  request_id?: string;
  instance_id?: string;
  task_id?: string;
};
export type ApprovalTask = WorkflowTask & { type?: "agent" | "approval"; instruction?: string; instance_id?: string };
export type ApprovalDetail = { item: ApprovalItem; skill?: ReturnType<typeof mapSkillDetail>; workflow?: WorkflowInstance; task?: ApprovalTask };
type RawApprovalDetail = Omit<ApprovalDetail, "skill"> & { skill?: AdminSkillDetailResponse };
export type ApprovalPage = { items: ApprovalItem[]; meta: { next_cursor: string; has_next: boolean } };
export type ApprovalFilters = { view: ApprovalView; type: ApprovalType; status: ApprovalStatus; cursor?: string };
export type WorkflowDecisionInput = { decision: "approve" | "reject"; comment: string; idempotency_key: string };

const requestPath = (id: string) => `/approvals/skill/${encodeURIComponent(id)}`;

export const approvalsApp = {
  list: (filters: ApprovalFilters, signal?: AbortSignal) => {
    const query = new URLSearchParams({ view: filters.view, type: filters.type, status: filters.status, limit: "20", cursor: filters.cursor ?? "" });
    return appApi.get<ApprovalPage>(`/approvals?${query}`, { signal });
  },
  detail: async (kind: ApprovalKind, id: string, signal?: AbortSignal): Promise<ApprovalDetail> => {
    const response = await appApi.get<RawApprovalDetail>(`/approvals/${kind}/${encodeURIComponent(id)}`, { signal });
    return { item: response.item, skill: response.skill ? mapSkillDetail(response.skill) : undefined, workflow: response.workflow, task: response.task };
  },
  skillDecision: (id: string, input: { decision: "approved" | "rejected"; comment: string; scores?: SkillReviewScores }) => appApi.post<unknown>(`${requestPath(id)}/decision`, input),
  workflowDecision: (id: string, input: WorkflowDecisionInput) => appApi.post<unknown>(`/workflow-tasks/${encodeURIComponent(id)}/decision`, input),
  files: (id: string, signal?: AbortSignal) => appApi.get<{ items: SkillVersionFile[] }>(`${requestPath(id)}/files`, { signal }),
  file: (id: string, path: string, signal?: AbortSignal) => appApi.get<SkillVersionFileContent>(`${requestPath(id)}/file?${new URLSearchParams({ path })}`, { signal }),
  packageURL: (id: string) => `/api/v1/app${requestPath(id)}/package`
};
