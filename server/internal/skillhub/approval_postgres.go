package skillhub

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *PostgresStore) SetSpaceApprover(ctx context.Context, spaceID, userID, operator string, now time.Time) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if userID != "" {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT status='active' FROM accounts WHERE user_id=$1 FOR SHARE`, userID).Scan(&active); err != nil || !active {
			return ErrMemberNotFound
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE skill_spaces SET approver_user_id=$2,updated_by=$3,updated_at=$4 WHERE space_id=$1 AND approval_provider='local'`, spaceID, nullableText(userID), operator, now)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrReviewForbidden
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) ReviewVersion(ctx context.Context, skillID, versionID, reviewer string, approve bool, comment string, now time.Time) (Version, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Version{}, err
	}
	defer tx.Rollback(ctx)
	var spaceID string
	if err := tx.QueryRow(ctx, `SELECT space_id FROM skills WHERE skill_id=$1 FOR UPDATE`, skillID).Scan(&spaceID); err != nil {
		return Version{}, mapNotFound(err)
	}
	var approver, provider string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(approver_user_id,''),approval_provider FROM skill_spaces WHERE space_id=$1 FOR SHARE`, spaceID).Scan(&approver, &provider); err != nil {
		return Version{}, err
	}
	if provider != "local" || approver == "" || approver != reviewer {
		return Version{}, ErrReviewForbidden
	}
	var active bool
	if err := tx.QueryRow(ctx, `SELECT status='active' FROM accounts WHERE user_id=$1 FOR SHARE`, reviewer).Scan(&active); err != nil {
		return Version{}, err
	}
	if !active {
		return Version{}, ErrReviewForbidden
	}
	var version Version
	if err := scanVersionSource(tx.QueryRow(ctx, `SELECT v.version_id,v.skill_id,v.version,v.description,v.changelog,v.package_path,v.package_sha256,v.created_at,
v.source_id,src.repository_owner,src.repository_name,v.source_path,v.source_commit_sha,v.source_content_sha256,
v.uploaded_by_user_id,v.uploaded_by_agent_id,v.skill_name,v.approval_status,COALESCE(v.approved_space_id,''),COALESCE(v.reviewed_by,''),v.reviewed_at,v.review_comment
FROM skill_versions v LEFT JOIN skill_sources src ON src.source_id=v.source_id
WHERE v.skill_id=$1 AND v.version_id=$2 FOR UPDATE OF v`, skillID, versionID), &version); err != nil {
		return Version{}, mapNotFound(err)
	}
	status := "rejected"
	if approve {
		status = "approved"
	}
	tag, err := tx.Exec(ctx, `UPDATE skill_versions SET approval_status=$3,approved_space_id=$4,reviewed_by=$5,reviewed_at=$6,review_comment=$7 WHERE skill_id=$1 AND version_id=$2 AND approval_status<>'approved'`, skillID, versionID, status, spaceID, reviewer, now, comment)
	if err != nil {
		return Version{}, err
	}
	if tag.RowsAffected() == 0 {
		return Version{}, ErrConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return Version{}, err
	}
	version.ApprovalStatus, version.ApprovedSpaceID, version.ReviewedBy, version.ReviewedAt, version.ReviewComment = status, spaceID, reviewer, &now, comment
	return version, nil
}
