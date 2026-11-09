import { adminApi } from "./api";

export type SkillReviewWorkflow = { id: "builtin:skill-review"; name: string; read_only: true; trigger: "upload"; review_skill: string; steps: Array<{ name: string; rule: string }> };
export type SkillReviewWorkflowRun = { request_id: string; skill_id: string; skill_name: string; version_id: string; version: string; uploaded_by: string; workflow_stage: string; ai_conclusion?: string; review_skill_version?: string; approved: number; total: number; score_total?: number; created_at: string };
export const skillReviewWorkflowApi = {
  definition: () => adminApi.get<SkillReviewWorkflow>("/skill-review-workflow"),
  runs: (stage: string, cursor: string, status = "all") => adminApi.get<{ items: SkillReviewWorkflowRun[]; meta: { next_cursor: string } }>(`/skill-review-workflow/runs?${new URLSearchParams({ stage, cursor, status, limit: "20" })}`)
};
