import type { EnterpriseWorkflowInstance, EnterpriseWorkflowTask } from './workflow.js';

export type EnterpriseApprovalKind = 'skill' | 'workflow' | 'workflow_instance';
export type EnterpriseApprovalFilters = {
  view: 'todo' | 'done' | 'initiated';
  type: 'all' | 'skill' | 'workflow';
  status: string;
  cursor?: string;
};
export type EnterpriseApprovalItem = {
  kind: EnterpriseApprovalKind;
  id: string;
  type: 'skill' | 'workflow';
  title: string;
  business_status: string;
  my_status: 'pending' | 'approved' | 'rejected' | '';
  created_at: string;
  acted_at?: string;
  can_process: boolean;
  workflow_stage?: string;
  can_retry_ai?: boolean;
  version_id?: string;
  version?: string;
};
export type EnterpriseReviewScores = Partial<Record<'scenario_value' | 'result_effectiveness' | 'ease_of_use' | 'reuse_value', number>>;
export type EnterpriseApprovalAIReview = {
  status: string;
  attempt_id: string;
  report?: {
    conclusion: string;
    summary: string;
    findings: Array<{ severity: string; message: string; path?: string }>;
    suggested_scores?: EnterpriseReviewScores;
  } | null;
};
export type EnterpriseSkillApproval = {
  request_id?: string;
  status: string;
  total: number;
  approved: number;
  ai_review?: EnterpriseApprovalAIReview | null;
  score_summary?: (EnterpriseReviewScores & { total: number }) | null;
  approvers: Array<{
    user_id: string;
    name: string;
    status: string;
    comment: string;
    decided_at: string | null;
    scores?: EnterpriseReviewScores | null;
  }>;
};
export type EnterpriseApprovalDetail = {
  item: EnterpriseApprovalItem;
  skill?: {
    skill: { name: string; description: string };
    versions: Array<{
      version_id: string;
      version: string;
      package_sha256?: string;
      description: string;
      changelog: string;
      local_approval?: EnterpriseSkillApproval;
    }>;
  };
  workflow?: EnterpriseWorkflowInstance;
  task?: EnterpriseWorkflowTask;
};
export type EnterpriseApprovalPage = {
  data: EnterpriseApprovalItem[];
  meta: { next_cursor: string; has_next: boolean };
};
export type EnterpriseApprovalFile = { path: string; size: number };
export type EnterpriseApprovalTrial = {
  trialId: string;
  projectId: string;
  skillName: string;
  version: string;
  expiresAt: string;
};
