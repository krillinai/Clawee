package skillhub

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

func recordFirstApproval(ctx context.Context, tx pgx.Tx, skillID, versionID, source, approvalID string, progress *LocalApproval, now time.Time) error {
	var skill Skill
	var version Version
	var coverage time.Time
	if err := tx.QueryRow(ctx, `SELECT s.skill_id,s.name,s.space_id,s.created_at,v.version_id,v.version,COALESCE(v.uploaded_by_user_id,''),v.uploaded_by_name,c.started_at FROM skills s JOIN skill_versions v ON v.skill_id=s.skill_id CROSS JOIN skill_contribution_coverage c WHERE s.skill_id=$1 AND v.version_id=$2`, skillID, versionID).Scan(&skill.SkillID, &skill.Name, &skill.SpaceID, &skill.CreatedAt, &version.VersionID, &version.Version, &version.UploadedByUserID, &version.UploadedByName, &coverage); err != nil {
		return err
	}
	if skill.CreatedAt.Before(coverage) || version.UploadedByUserID == "" {
		return nil
	}
	snapshot, err := json.Marshal(firstApprovalRecord(skill, version, source, approvalID, progress, now))
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO skill_first_approvals(skill_id,first_approved_at,snapshot) VALUES($1,$2,$3) ON CONFLICT(skill_id) DO NOTHING`, skillID, now, snapshot)
	return err
}

func (s *PostgresStore) contributionCoverage(ctx context.Context, reader approvalReader) (ContributionCoverage, error) {
	coverage := ContributionCoverage{Notice: "首次通过仅包含覆盖起点后创建的 Skill；旧 Skill 历史首次通过无法确认，上传仅包含已采集的成功上传事实。"}
	err := reader.QueryRow(ctx, `SELECT started_at,(SELECT min(occurred_at) FROM employee_ai_activity_facts WHERE actor_kind='user' AND origin IN ('app_upload','admin_upload')) FROM skill_contribution_coverage`).Scan(&coverage.FirstApprovalsFrom, &coverage.UploadsFrom)
	return coverage, err
}

const contributionUploadsSQL = `SELECT f.fact_id,f.actor_user_id,COALESCE(f.actor_name,a.name,''),f.target_id,f.target_name,f.source_event_key,f.version_label,COALESCE(s.space_id,''),f.origin,f.occurred_at,v.approval_status,v.version_id IS NOT NULL,
CASE WHEN s.created_at < (SELECT started_at FROM skill_contribution_coverage) THEN 'unknown' WHEN s.skill_id IS NULL THEN 'unknown' ELSE 'covered' END,
COALESCE((SELECT jsonb_build_object('request_id',r.id,'status',r.status,'scoring_standard_version',COALESCE(r.scoring_standard_version,''),'approvers',
 COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',p.user_id,'name',COALESCE(u.name,''),'status',p.status,'comment',p.comment,'decided_at',p.decided_at,'scores',jsonb_build_object('scenario_value',p.scenario_value,'result_effectiveness',p.result_effectiveness,'ease_of_use',p.ease_of_use,'reuse_value',p.reuse_value)) ORDER BY p.user_id) FROM approval_request_approvers p LEFT JOIN accounts u ON u.user_id=p.user_id WHERE p.request_id=r.id),'[]'::jsonb))
 FROM approval_requests r WHERE r.business_type='skill_version' AND r.action='publish' AND r.business_id=v.version_id AND r.scope_id=s.space_id AND r.content_digest=v.package_sha256 AND r.status<>'invalidated' ORDER BY r.created_at DESC,r.id DESC LIMIT 1),'null'::jsonb),
(SELECT ai.id FROM skill_version_approval_instances ai WHERE ai.version_id=v.version_id AND ai.space_id=s.space_id AND ai.status<>'invalidated' ORDER BY ai.created_at DESC,ai.id DESC LIMIT 1)
FROM employee_ai_activity_facts f LEFT JOIN skill_versions v ON v.version_id=f.source_event_key LEFT JOIN skills s ON s.skill_id=f.target_id LEFT JOIN accounts a ON a.user_id=f.actor_user_id
WHERE f.actor_kind='user' AND f.origin IN ('app_upload','admin_upload') AND f.event_type IN ('skill.created','skill.version_uploaded')`

func (s *PostgresStore) contributionUploads(ctx context.Context, reader approvalReader, clause string, arguments ...any) ([]ContributionRecord, error) {
	rows, err := reader.Query(ctx, contributionUploadsSQL+clause, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ContributionRecord{}
	for rows.Next() {
		var row ContributionRecord
		var raw []byte
		if err := rows.Scan(&row.ID, &row.EmployeeID, &row.EmployeeName, &row.SkillID, &row.SkillName, &row.VersionID, &row.Version, &row.SpaceID, &row.Source, &row.OccurredAt, &row.Status, &row.EntityAvailable, &row.HistoryStatus, &raw, &row.ApprovalID); err != nil {
			return nil, err
		}
		row.Approvers = []ApprovalDecision{}
		var progress *LocalApproval
		if err := json.Unmarshal(raw, &progress); err != nil {
			return nil, err
		}
		if progress != nil {
			summarizeScores(progress)
			row.ApprovalID = &progress.RequestID
			row.ScoringStandardVersion = &progress.ScoringStandardVersion
			row.Scores, row.Approvers = progress.ScoreSummary, progress.Approvers
		}
		items = append(items, row)
	}
	return items, rows.Err()
}

func (s *PostgresStore) contributionApprovals(ctx context.Context, reader approvalReader, clause string, arguments ...any) ([]ContributionRecord, error) {
	rows, err := reader.Query(ctx, `SELECT f.snapshot,EXISTS(SELECT 1 FROM skill_versions v WHERE v.version_id=f.snapshot->>'version_id') FROM skill_first_approvals f WHERE TRUE`+clause, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ContributionRecord{}
	for rows.Next() {
		var raw []byte
		var available bool
		if err := rows.Scan(&raw, &available); err != nil {
			return nil, err
		}
		var row ContributionRecord
		if err := json.Unmarshal(raw, &row); err != nil {
			return nil, err
		}
		row.EntityAvailable = available
		items = append(items, row)
	}
	return items, rows.Err()
}

func (s *PostgresStore) ContributionData(ctx context.Context, query ContributionQuery) ([]ContributionRecord, []ContributionRecord, ContributionCoverage, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, nil, ContributionCoverage{}, err
	}
	defer tx.Rollback(ctx)
	coverage, err := s.contributionCoverage(ctx, tx)
	if err != nil {
		return nil, nil, coverage, err
	}
	start, end := contributionBounds(query)
	uploads, err := s.contributionUploads(ctx, tx, ` AND f.occurred_at >= $1 AND f.occurred_at < $2 AND ($3='' OR f.actor_user_id=$3)`, start, end, query.EmployeeID)
	if err != nil {
		return nil, nil, coverage, err
	}
	approvals, err := s.contributionApprovals(ctx, tx, ` AND f.first_approved_at >= $1 AND f.first_approved_at < $2 AND ($3='' OR f.snapshot->>'employee_id'=$3)`, start, end, query.EmployeeID)
	if err == nil {
		err = tx.Commit(ctx)
	}
	return uploads, approvals, coverage, err
}

func (s *PostgresStore) ContributionDetail(ctx context.Context, skillID, versionID string) (ContributionRecord, ContributionCoverage, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ContributionRecord{}, ContributionCoverage{}, err
	}
	defer tx.Rollback(ctx)
	coverage, err := s.contributionCoverage(ctx, tx)
	if err != nil {
		return ContributionRecord{}, coverage, err
	}
	var rows []ContributionRecord
	if skillID != "" {
		rows, err = s.contributionApprovals(ctx, tx, ` AND f.skill_id=$1`, skillID)
	} else {
		rows, err = s.contributionUploads(ctx, tx, ` AND f.source_event_key=$1`, versionID)
	}
	if err != nil {
		return ContributionRecord{}, coverage, err
	}
	if len(rows) == 0 {
		return ContributionRecord{}, coverage, ErrNotFound
	}
	return rows[0], coverage, tx.Commit(ctx)
}
