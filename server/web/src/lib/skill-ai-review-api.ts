import { adminApi, appApi } from "./api";

export type SkillAIReviewStatus = "pending" | "running" | "completed" | "failed" | "manual";
export type SkillAIScores = Record<"scenario_value" | "result_effectiveness" | "ease_of_use" | "reuse_value", number>;
export type RawSkillAIReport = {
  conclusion: "recommend_approve" | "recommend_reject" | "needs_attention";
  summary: string;
  findings: Array<{ severity: "info" | "warning" | "error"; message: string; path?: string }>;
  suggested_scores?: SkillAIScores;
};
export type RawSkillAIReview = {
  status: SkillAIReviewStatus;
  attempt_id: string;
  agent_id: string;
  report?: RawSkillAIReport | null;
  error?: string;
  updated_at: string;
  manual_by?: string;
  manual_at?: string;
  manual_comment?: string;
  attempts?: Array<Omit<RawSkillAIReview, "attempts">>;
};
export type SkillAIReview = {
  status: SkillAIReviewStatus;
  attemptId: string;
  agentId: string;
  report?: Omit<RawSkillAIReport, "suggested_scores"> & { suggestedScores?: SkillAIScores };
  error?: string;
  updatedAt: string;
  manualBy?: string;
  manualAt?: string;
  manualComment?: string;
  attempts?: SkillAIReview[];
};

export function mapSkillAIReview(raw: RawSkillAIReview): SkillAIReview {
  return {
    status: raw.status,
    attemptId: raw.attempt_id,
    agentId: raw.agent_id,
    updatedAt: raw.updated_at,
    ...(raw.manual_by ? { manualBy: raw.manual_by } : {}),
    ...(raw.manual_at ? { manualAt: raw.manual_at } : {}),
    ...(raw.manual_comment ? { manualComment: raw.manual_comment } : {}),
    ...(raw.error ? { error: raw.error } : {}),
    ...(raw.report ? { report: {
      conclusion: raw.report.conclusion,
      summary: raw.report.summary,
      findings: raw.report.findings,
      ...(raw.report.suggested_scores ? { suggestedScores: raw.report.suggested_scores } : {})
    } } : {}),
    ...(raw.attempts ? { attempts: raw.attempts.map(mapSkillAIReview) } : {})
  };
}

export function skillAIAllowsScoring(review?: SkillAIReview): boolean {
  return !review || review.status === "completed" || review.status === "manual";
}

export type SkillAIReviewConfig = { enabled: boolean; agent_id: string };
const configPath = (spaceId: string) => `/skill-spaces/${encodeURIComponent(spaceId)}/ai-review`;
const actionPath = (requestId: string) => `/approvals/skill/${encodeURIComponent(requestId)}/ai-review`;

export const skillAIReviewApi = {
  getConfig: (spaceId: string) => adminApi.get<SkillAIReviewConfig>(configPath(spaceId)),
  saveConfig: (spaceId: string, config: SkillAIReviewConfig) => adminApi.put<unknown>(configPath(spaceId), { enabled: config.enabled, agent_id: config.enabled ? config.agent_id.trim() : "" }),
  retry: (requestId: string, attemptId: string) => appApi.post<unknown>(`${actionPath(requestId)}/retry`, { attempt_id: attemptId }),
  manual: (requestId: string, attemptId: string, comment: string) => appApi.post<unknown>(`${actionPath(requestId)}/manual`, { attempt_id: attemptId, comment: comment.trim() })
};
