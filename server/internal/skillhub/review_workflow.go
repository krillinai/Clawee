package skillhub

import "time"

// 所有本地人工上传共用同一前置门禁；Git 来源不接入 P9。
const aiHumanGateSQL = `EXISTS(SELECT 1 FROM skill_ai_review_attempts ai WHERE ai.request_id=r.id
AND ai.attempt_id=(SELECT attempt_id FROM skill_ai_review_attempts WHERE request_id=r.id ORDER BY created_at DESC,attempt_id DESC LIMIT 1)
AND ai.status='completed' AND ai.review_skill_version<>'' AND ai.review_skill_sha256 ~ '^[a-f0-9]{64}$'
AND ai.report->>'conclusion'='recommend_approve'
AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ai.report->'findings') finding WHERE finding->>'severity'='error'))`

const aiReviewRetrySQL = `r.status='pending' AND v.approval_status='pending' AND r.scope_id=s.space_id AND r.content_digest=v.package_sha256
AND (ai.status='failed' OR (ai.status='running' AND ai.started_at<=now()-interval '15 minutes')) AND ai.error_code<>'materials_unsupported'`

// r、v 是申请及版本，ai 是最新尝试，派生阶段不另行持久化。
const reviewWorkflowStageSQL = `CASE WHEN v.source_id IS NOT NULL THEN '' WHEN r.status='invalidated' OR r.scope_id<>s.space_id OR r.content_digest<>v.package_sha256 THEN 'invalidated'
WHEN ai.attempt_id IS NULL THEN ''
WHEN ai.status='pending' THEN 'ai_pending'
WHEN ai.status='running' AND ai.started_at>now()-interval '15 minutes' THEN 'ai_running'
WHEN ai.error_code='materials_unsupported' THEN 'revision_required'
WHEN ai.status IN ('failed','running') THEN 'ai_failed'
WHEN NOT (` + aiHumanGateSQL + `) THEN CASE WHEN ai.status IN ('completed','manual') THEN 'revision_required' ELSE 'ai_pending' END
WHEN r.status='rejected' THEN 'rejected'
WHEN r.status='approved' AND EXISTS(SELECT 1 FROM approval_request_approvers a WHERE a.request_id=r.id)
AND NOT EXISTS(SELECT 1 FROM approval_request_approvers a WHERE a.request_id=r.id AND (a.status<>'approved' OR a.scenario_value IS NULL OR a.result_effectiveness IS NULL OR a.ease_of_use IS NULL OR a.reuse_value IS NULL)) THEN 'approved'
ELSE 'human_pending' END`

func workflowStage(progress *LocalApproval) string {
	if progress == nil {
		return ""
	}
	if progress.Status == "invalidated" {
		return "invalidated"
	}
	review := progress.AIReview
	if review == nil {
		return ""
	}
	switch review.Status {
	case "pending":
		return "ai_pending"
	case "running":
		return "ai_running"
	case "failed":
		if review.ErrorCode == "materials_unsupported" {
			return "revision_required"
		}
		return "ai_failed"
	}
	if !aiAllowsHuman([]AIReviewAttempt{review.AIReviewAttempt}, time.Now().UTC()) {
		return "revision_required"
	}
	if progress.Status == "rejected" {
		return "rejected"
	}
	if progress.Status == "approved" && progress.ScoreSummary != nil {
		return "approved"
	}
	return "human_pending"
}
