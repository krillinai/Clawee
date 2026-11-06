import { appApi } from "./api";

export type SkillAIReviewStatus = "pending" | "running" | "completed" | "failed" | "manual";
export type SkillAIReviewAgentState = "unknown" | "online" | "blocked" | "offline";
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
  error_code?: string;
  review_skill_version?: string;
  review_skill_sha256?: string;
  updated_at: string;
  manual_by?: string;
  manual_at?: string;
  manual_comment?: string;
  attempts?: Array<Omit<RawSkillAIReview, "attempts">>;
  agent_presence?: { agent_id: string; state: SkillAIReviewAgentState; last_seen_at?: string; last_error_code?: string; last_error?: string };
};
export type SkillAIReview = {
  status: SkillAIReviewStatus;
  attemptId: string;
  agentId: string;
  report?: Omit<RawSkillAIReport, "suggested_scores"> & { suggestedScores?: SkillAIScores };
  error?: string;
  errorCode?: string;
  reviewSkillVersion?: string;
  reviewSkillSHA256?: string;
  updatedAt: string;
  manualBy?: string;
  manualAt?: string;
  manualComment?: string;
  attempts?: SkillAIReview[];
  agentPresence?: { agentId: string; state: SkillAIReviewAgentState; lastSeenAt?: string; lastErrorCode?: string; lastError?: string };
};

export function mapSkillAIReview(raw: RawSkillAIReview): SkillAIReview {
  return {
    status: raw.status,
    attemptId: raw.attempt_id,
    agentId: raw.agent_id,
    updatedAt: raw.updated_at,
    errorCode: raw.error_code,
    reviewSkillVersion: raw.review_skill_version,
    reviewSkillSHA256: raw.review_skill_sha256,
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
    ...(raw.attempts ? { attempts: raw.attempts.map(mapSkillAIReview) } : {}),
    ...(raw.agent_presence ? { agentPresence: {
      agentId: raw.agent_presence.agent_id,
      state: raw.agent_presence.state,
      ...(raw.agent_presence.last_seen_at ? { lastSeenAt: raw.agent_presence.last_seen_at } : {}),
      ...(raw.agent_presence.last_error_code ? { lastErrorCode: raw.agent_presence.last_error_code } : {}),
      ...(raw.agent_presence.last_error ? { lastError: raw.agent_presence.last_error } : {})
    } } : {})
  };
}

export function skillAIAllowsScoring(review?: SkillAIReview): boolean {
  return !review || (review.status === "completed" && review.report?.conclusion === "recommend_approve" && Boolean(review.reviewSkillVersion) && /^[a-f0-9]{64}$/.test(review.reviewSkillSHA256 ?? "") && !review.report.findings.some(finding => finding.severity === "error"));
}

export const skillWorkflowStageLabels: Record<string, string> = { ai_pending: "待 AI 评估", ai_running: "AI 评估中", revision_required: "需修改", ai_failed: "评估执行异常", human_pending: "待人工审核", approved: "审核通过", rejected: "人工驳回", invalidated: "本轮失效" };

const actionPath = (requestId: string) => `/approvals/skill/${encodeURIComponent(requestId)}/ai-review`;

export const skillAIReviewApi = {
  retry: (requestId: string, attemptId: string) => appApi.post<unknown>(`${actionPath(requestId)}/retry`, { attempt_id: attemptId })
};
