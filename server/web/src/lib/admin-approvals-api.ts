import { adminApi } from "./api";
import { mapSkillDetail, type AdminSkillDetailResponse, type SkillVersionFile, type SkillVersionFileContent } from "./skillhub-api";
import type { WorkflowInstance } from "./workflow-api";

export type AdminApprovalKind = "skill" | "skill_external" | "workflow_instance";
export type AdminApprovalItem = {
  kind: AdminApprovalKind;
  id: string;
  type: "skill" | "workflow";
  title: string;
  channel: "local" | "dingtalk" | "workflow";
  status: string;
  business_status: string;
  initiated_by: string;
  initiated_name: string;
  created_at: string;
  space_id?: string;
  space_name?: string;
  skill_id?: string;
  version_id?: string;
  version?: string;
  template_id?: string;
  task_id?: string;
  current_node?: string;
  current_approvers: string[];
  current_approver_names: string[];
  progress_completed: number;
  progress_total: number;
  can_process: boolean;
  workflow_stage?: string;
  can_retry_ai?: boolean;
  materials_available: boolean;
  content_digest?: string;
};
export type AdminApprovalFilters = {
  view: string; type: string; status: string; channel: string;
  q?: string; initiated_by?: string; space_id?: string; template_id?: string; from?: string; until?: string;
};
export type AdminApprovalSummary = { total: number; pending: number; running: number; abnormal: number };
export type AdminApprovalDetail = {
  item: AdminApprovalItem;
  skill?: ReturnType<typeof mapSkillDetail>;
  workflow?: WorkflowInstance;
  events?: Array<{ id: string; type: string; actor: string; actor_name: string; reason?: string; created_at: string }>;
  actions: { terminate?: boolean; sync?: boolean; resolve?: boolean };
};
type RawDetail = Omit<AdminApprovalDetail, "skill"> & { skill?: AdminSkillDetailResponse };
const detailPath = (kind: AdminApprovalKind, id: string) => `/approvals/${kind}/${encodeURIComponent(id)}`;
const filterQuery = (filters: AdminApprovalFilters) => new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== "") as [string, string][]);

export const approvalsAdmin = {
  list: (filters: AdminApprovalFilters, cursor = "", signal?: AbortSignal) => {
    const params = filterQuery(filters);
    params.set("limit", "20");
    params.set("cursor", cursor);
    return adminApi.get<{ items: AdminApprovalItem[]; meta: { has_next: boolean; next_cursor: string } }>(`/approvals?${params}`, { signal });
  },
  summary: (filters: AdminApprovalFilters, signal?: AbortSignal) => adminApi.get<AdminApprovalSummary>(`/approvals/summary?${filterQuery(filters)}`, { signal }),
  detail: async (kind: AdminApprovalKind, id: string, signal?: AbortSignal): Promise<AdminApprovalDetail> => {
    const response = await adminApi.get<RawDetail>(detailPath(kind, id), { signal });
    return { ...response, skill: response.skill ? mapSkillDetail(response.skill) : undefined };
  },
  files: (kind: AdminApprovalKind, id: string) => adminApi.get<{ items: SkillVersionFile[] }>(`${detailPath(kind, id)}/files`),
  file: (kind: AdminApprovalKind, id: string, path: string) => adminApi.get<SkillVersionFileContent>(`${detailPath(kind, id)}/file?${new URLSearchParams({ path })}`),
  packageURL: (kind: AdminApprovalKind, id: string) => `/api/v1/admin${detailPath(kind, id)}/package`
};
