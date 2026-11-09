package skillhub

import (
	"context"
	"sort"
	"time"
)

type ReviewWorkflowQuery struct {
	Stage      string
	Status     string
	BeforeTime time.Time
	BeforeID   string
	Limit      int
}

func reviewWorkflowStatus(stage string) string {
	switch stage {
	case "approved":
		return "succeeded"
	case "rejected", "revision_required":
		return stage
	case "invalidated":
		return "terminated"
	case "ai_failed":
		return "error"
	default:
		return "running"
	}
}

func ValidReviewWorkflowStatus(status string) bool {
	switch status {
	case "", "all", "running", "succeeded", "rejected", "terminated", "error", "revision_required":
		return true
	default:
		return false
	}
}

type ReviewWorkflowRun struct {
	RequestID          string    `json:"request_id"`
	SkillID            string    `json:"skill_id"`
	SkillName          string    `json:"skill_name"`
	VersionID          string    `json:"version_id"`
	Version            string    `json:"version"`
	UploadedBy         string    `json:"uploaded_by"`
	WorkflowStage      string    `json:"workflow_stage"`
	AIConclusion       string    `json:"ai_conclusion,omitempty"`
	ReviewSkillVersion string    `json:"review_skill_version,omitempty"`
	Approved           int       `json:"approved"`
	Total              int       `json:"total"`
	ScoreTotal         *float64  `json:"score_total,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
}

func ValidReviewWorkflowStage(stage string) bool {
	switch stage {
	case "", "ai_pending", "ai_running", "revision_required", "ai_failed", "human_pending", "approved", "rejected", "invalidated":
		return true
	default:
		return false
	}
}

func (s *Service) ListReviewWorkflowRuns(ctx context.Context, user string, query ReviewWorkflowQuery) ([]ReviewWorkflowRun, error) {
	store, ok := s.store.(interface {
		listReviewWorkflowRuns(context.Context, string, ReviewWorkflowQuery) ([]ReviewWorkflowRun, error)
	})
	if !ok || user == "" || query.Limit < 1 || query.Limit > 51 || !ValidReviewWorkflowStage(query.Stage) || !ValidReviewWorkflowStatus(query.Status) {
		return nil, ErrInvalidRequest
	}
	return store.listReviewWorkflowRuns(ctx, user, query)
}

func (s *MemoryStore) listReviewWorkflowRuns(_ context.Context, user string, query ReviewWorkflowQuery) ([]ReviewWorkflowRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []ReviewWorkflowRun{}
	for skillID, versions := range s.versions {
		skill := s.skills[skillID]
		if !s.hasAccessLocked(user, skill.SpaceID, SpaceActionRead) {
			continue
		}
		for _, version := range versions {
			if version.Source != nil {
				continue
			}
			for index := range s.localApprovals[version.VersionID] {
				request := &s.localApprovals[version.VersionID][index]
				if len(request.AIAttempts) == 0 || !s.hasAccessLocked(user, request.SpaceID, SpaceActionRead) {
					continue
				}
				progress := localProgress(request)
				if query.Stage != "" && progress.WorkflowStage != query.Stage {
					continue
				}
				if query.Status != "" && query.Status != "all" && reviewWorkflowStatus(progress.WorkflowStage) != query.Status {
					continue
				}
				if !query.BeforeTime.IsZero() && (request.CreatedAt.After(query.BeforeTime) || request.CreatedAt.Equal(query.BeforeTime) && request.ID >= query.BeforeID) {
					continue
				}
				item := ReviewWorkflowRun{RequestID: request.ID, SkillID: skillID, SkillName: skill.Name, VersionID: version.VersionID, Version: version.Version, UploadedBy: version.UploadedByUserID, WorkflowStage: progress.WorkflowStage, Approved: progress.Approved, Total: progress.Total, CreatedAt: request.CreatedAt, ReviewSkillVersion: progress.AIReview.ReviewSkillVersion}
				if progress.AIReview.Report != nil {
					item.AIConclusion = progress.AIReview.Report.Conclusion
				}
				if progress.ScoreSummary != nil && progress.WorkflowStage == "approved" {
					total := progress.ScoreSummary.Total
					item.ScoreTotal = &total
				}
				items = append(items, item)
			}
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].RequestID > items[j].RequestID
		}
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
	if len(items) > query.Limit {
		items = items[:query.Limit]
	}
	return items, nil
}

func (s *PostgresStore) listReviewWorkflowRuns(ctx context.Context, user string, query ReviewWorkflowQuery) ([]ReviewWorkflowRun, error) {
	at := query.BeforeTime
	if at.IsZero() {
		at = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	rows, err := s.pool.Query(ctx, `SELECT request_id,skill_id,skill_name,version_id,version,uploaded_by,workflow_stage,ai_conclusion,review_skill_version,approved,total,
 CASE WHEN workflow_stage='approved' THEN score_total ELSE NULL END,created_at FROM (
 SELECT r.id request_id,s.skill_id,s.name skill_name,v.version_id,v.version,COALESCE(v.uploaded_by_user_id,'') uploaded_by,
 (`+reviewWorkflowStageSQL+`) workflow_stage,COALESCE(ai.report->>'conclusion','') ai_conclusion,ai.review_skill_version,
 (SELECT count(*) FROM approval_request_approvers a WHERE a.request_id=r.id AND a.status='approved') approved,
 (SELECT count(*) FROM approval_request_approvers a WHERE a.request_id=r.id) total,
 (SELECT avg(scenario_value)+avg(result_effectiveness)+avg(ease_of_use)+avg(reuse_value) FROM approval_request_approvers a WHERE a.request_id=r.id) score_total,r.created_at
 FROM approval_requests r JOIN skill_versions v ON v.version_id=r.business_id JOIN skills s ON s.skill_id=v.skill_id
 JOIN LATERAL(SELECT * FROM skill_ai_review_attempts WHERE request_id=r.id ORDER BY created_at DESC,attempt_id DESC LIMIT 1) ai ON true
 WHERE r.business_type='skill_version' AND r.action='publish' AND r.scope_type='skill_space' AND v.source_id IS NULL
 AND EXISTS(SELECT 1 FROM accounts WHERE user_id=$1 AND status='active')
 AND EXISTS(SELECT 1 FROM effective_data_resource_permissions WHERE user_id=$1 AND resource_type='skill_space' AND resource_id=r.scope_id AND action='read')
 AND EXISTS(SELECT 1 FROM effective_data_resource_permissions WHERE user_id=$1 AND resource_type='skill_space' AND resource_id=s.space_id AND action='read')
 ) runs WHERE ($2='' OR workflow_stage=$2) AND (created_at,request_id COLLATE "C")<($3,$4::text COLLATE "C")
 AND ($6 IN ('','all') OR (CASE WHEN workflow_stage='approved' THEN 'succeeded' WHEN workflow_stage='invalidated' THEN 'terminated'
 WHEN workflow_stage='ai_failed' THEN 'error' WHEN workflow_stage IN ('rejected','revision_required') THEN workflow_stage ELSE 'running' END)=$6)
 ORDER BY created_at DESC,request_id COLLATE "C" DESC LIMIT $5`, user, query.Stage, at, query.BeforeID, query.Limit, query.Status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ReviewWorkflowRun{}
	for rows.Next() {
		var item ReviewWorkflowRun
		if err := rows.Scan(&item.RequestID, &item.SkillID, &item.SkillName, &item.VersionID, &item.Version, &item.UploadedBy, &item.WorkflowStage, &item.AIConclusion, &item.ReviewSkillVersion, &item.Approved, &item.Total, &item.ScoreTotal, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
