package skillhub

import (
	"context"

	"github.com/krillinai/Clawee/server/internal/approvals"
)

const adminApprovalRecordsSQL = `WITH records AS (
SELECT 'skill'::text AS kind,r.id,'skill'::text AS type,s.name AS title,'local'::text AS channel,r.status AS status,r.status AS business_status,
COALESCE(v.uploaded_by_user_id,'') AS initiated_by,COALESCE(u.name,'') AS initiated_name,r.created_at,
r.scope_id AS space_id,sp.name AS space_name,s.skill_id,v.version_id,v.version,''::text AS template_id,''::text AS task_id,''::text AS current_node,
ARRAY(SELECT ap.user_id FROM approval_request_approvers ap WHERE ap.request_id=r.id AND ap.status='pending' AND r.status='pending' ORDER BY ap.user_id) AS current_approvers,
ARRAY(SELECT COALESCE(NULLIF(au.name,''),ap.user_id) FROM approval_request_approvers ap JOIN accounts au ON au.user_id=ap.user_id WHERE ap.request_id=r.id AND ap.status='pending' AND r.status='pending' ORDER BY ap.user_id) AS current_approver_names,
(SELECT count(*) FROM approval_request_approvers ap WHERE ap.request_id=r.id AND ap.status<>'pending')::int AS progress_completed,
(SELECT count(*) FROM approval_request_approvers ap WHERE ap.request_id=r.id)::int AS progress_total,
COALESCE((` + personalApprovalProcessSQL + `),false) AS can_process,
(r.status<>'invalidated' AND r.scope_id=s.space_id AND r.content_digest=v.package_sha256) AS materials_available,r.content_digest
FROM approval_requests r JOIN skill_versions v ON v.version_id=r.business_id JOIN skills s ON s.skill_id=v.skill_id
JOIN skill_spaces sp ON sp.space_id=r.scope_id LEFT JOIN accounts u ON u.user_id=v.uploaded_by_user_id
LEFT JOIN approval_request_approvers a ON a.request_id=r.id AND a.user_id=$1
WHERE r.business_type='skill_version' AND r.action='publish' AND r.scope_type='skill_space'
AND EXISTS (SELECT 1 FROM accounts actor WHERE actor.user_id=$1 AND actor.status='active')
AND EXISTS (SELECT 1 FROM effective_data_resource_permissions g WHERE g.user_id=$1 AND g.resource_type='skill_space' AND g.resource_id=r.scope_id AND g.action='read')
AND EXISTS (SELECT 1 FROM effective_data_resource_permissions g WHERE g.user_id=$1 AND g.resource_type='skill_space' AND g.resource_id=s.space_id AND g.action='read')
UNION ALL
SELECT 'skill_external',e.id,'skill',s.name,'dingtalk',
CASE WHEN e.status IN ('failed','uncertain') THEN 'error' WHEN e.status IN ('submitting','running') THEN 'running' WHEN e.status='finished' THEN COALESCE(e.decision,'error') ELSE e.status END,e.status,
e.initiator_user_id,COALESCE(u.name,''),e.created_at,e.space_id,sp.name,s.skill_id,v.version_id,v.version,'','','',ARRAY[]::text[],ARRAY[]::text[],0,0,false,
(e.status<>'invalidated' AND e.space_id=s.space_id AND e.package_sha256=v.package_sha256),e.package_sha256
FROM skill_version_approval_instances e JOIN skill_versions v ON v.version_id=e.version_id JOIN skills s ON s.skill_id=v.skill_id
JOIN skill_spaces sp ON sp.space_id=e.space_id LEFT JOIN accounts u ON u.user_id=e.initiator_user_id
WHERE EXISTS (SELECT 1 FROM accounts actor WHERE actor.user_id=$1 AND actor.status='active')
AND EXISTS (SELECT 1 FROM effective_data_resource_permissions g WHERE g.user_id=$1 AND g.resource_type='skill_space' AND g.resource_id=e.space_id AND g.action='read')
AND EXISTS (SELECT 1 FROM effective_data_resource_permissions g WHERE g.user_id=$1 AND g.resource_type='skill_space' AND g.resource_id=s.space_id AND g.action='read')
) `

func (s *PostgresStore) ListAdminApprovals(ctx context.Context, user string, filter approvals.Filter, limit int, administrator bool) ([]approvals.Record, error) {
	rows, err := s.pool.Query(ctx, adminApprovalRecordsSQL+`SELECT `+approvals.Columns+` FROM records`+approvals.FilterSQL+approvals.PageSQL, filter.PageArgs(user, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []approvals.Record{}
	for rows.Next() {
		item, err := approvals.Scan(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	ids := []string{}
	for _, item := range items {
		if item.Kind == "skill" {
			ids = append(ids, item.ID)
		}
	}
	if len(ids) > 0 {
		stages, err := s.pool.Query(ctx, `SELECT r.id,(`+reviewWorkflowStageSQL+`),COALESCE((`+aiReviewRetrySQL+`) AND (v.uploaded_by_user_id=$2 OR $3),false) FROM approval_requests r JOIN skill_versions v ON v.version_id=r.business_id JOIN skills s ON s.skill_id=v.skill_id LEFT JOIN LATERAL(SELECT * FROM skill_ai_review_attempts WHERE request_id=r.id ORDER BY created_at DESC,attempt_id DESC LIMIT 1) ai ON true WHERE r.id=ANY($1)`, ids, user, administrator)
		if err != nil {
			return nil, err
		}
		defer stages.Close()
		for stages.Next() {
			var id, stage string
			var canRetry bool
			if err := stages.Scan(&id, &stage, &canRetry); err != nil {
				return nil, err
			}
			for i := range items {
				if items[i].ID == id {
					items[i].WorkflowStage = stage
					items[i].CanRetryAI = canRetry
					items[i].CanSubmitReview = items[i].CanProcess
				}
			}
		}
		if err := stages.Err(); err != nil {
			return nil, err
		}
	}
	return items, nil
}

func (s *PostgresStore) AdminApprovalSummary(ctx context.Context, user string, filter approvals.Filter) (approvals.Summary, error) {
	var summary approvals.Summary
	err := s.pool.QueryRow(ctx, adminApprovalRecordsSQL+approvals.SummarySQL+approvals.FilterSQL, filter.Args(user)...).Scan(&summary.Total, &summary.Pending, &summary.Running, &summary.Abnormal)
	return summary, err
}

func (s *PostgresStore) GetAdminApproval(ctx context.Context, user, kind, id string) (approvals.Record, AdminDetail, error) {
	item, err := approvals.Scan(s.pool.QueryRow(ctx, adminApprovalRecordsSQL+`SELECT `+approvals.Columns+` FROM records WHERE kind=$2 AND id=$3`, user, kind, id))
	if err != nil {
		return item, AdminDetail{}, mapNotFound(err)
	}
	detail, err := s.GetAdmin(ctx, item.SkillID)
	if err != nil {
		return item, detail, err
	}
	for _, version := range detail.Versions {
		if version.VersionID != item.VersionID {
			continue
		}
		version.LocalApproval, version.ApprovalInstance = nil, nil
		if kind == "skill" {
			var standard string
			if err = s.pool.QueryRow(ctx, `SELECT COALESCE(scoring_standard_version,'') FROM approval_requests WHERE id=$1`, id).Scan(&standard); err != nil {
				return item, AdminDetail{}, err
			}
			version.LocalApproval, err = readLocalRequestProgress(ctx, s.pool, id, item.BusinessStatus, standard, item.ContentDigest)
		} else {
			var external ApprovalInstance
			external, err = s.GetApprovalByID(ctx, id)
			version.ApprovalInstance = &external
		}
		if err != nil {
			return item, AdminDetail{}, err
		}
		detail.Versions = []Version{version}
		return item, detail, nil
	}
	return item, AdminDetail{}, ErrNotFound
}
