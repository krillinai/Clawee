package skillhub

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *PostgresStore) ResubmitReview(ctx context.Context, skillID, versionID, requestID, userID string, now time.Time) (Version, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Version{}, err
	}
	defer tx.Rollback(ctx)
	var spaceID string
	if err = tx.QueryRow(ctx, `SELECT space_id FROM skills WHERE skill_id=$1`, skillID).Scan(&spaceID); err != nil {
		return Version{}, mapNotFound(err)
	}
	var provider string
	var configured bool
	if err = tx.QueryRow(ctx, `SELECT approval_provider,
EXISTS(SELECT 1 FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$1)
OR EXISTS(SELECT 1 FROM approval_config_roles WHERE scope_type='skill_space' AND scope_id=$1)
FROM skill_spaces WHERE space_id=$1 FOR SHARE`, spaceID).Scan(&provider, &configured); err != nil {
		return Version{}, err
	}
	if provider != "local" || !configured {
		return Version{}, ErrReviewForbidden
	}
	var actualSpace string
	var currentVersionID *string
	if err = tx.QueryRow(ctx, `SELECT space_id,current_version_id FROM skills WHERE skill_id=$1 FOR UPDATE`, skillID).Scan(&actualSpace, &currentVersionID); err != nil {
		return Version{}, mapNotFound(err)
	}
	if actualSpace != spaceID {
		return Version{}, ErrConflict
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT status='active' AND EXISTS(SELECT 1 FROM effective_data_resource_permissions WHERE user_id=$1 AND resource_type='skill_space' AND resource_id=$2 AND action='read') FROM accounts WHERE user_id=$1 FOR SHARE`, userID, spaceID).Scan(&active); err != nil || !active {
		return Version{}, ErrReviewForbidden
	}
	var version Version
	if err = scanVersionSource(tx.QueryRow(ctx, `SELECT v.version_id,v.skill_id,v.version,v.description,v.changelog,v.package_path,v.package_sha256,v.created_at,
v.source_id,src.repository_owner,src.repository_name,v.source_path,v.source_commit_sha,v.source_content_sha256,
v.uploaded_by_user_id,v.uploaded_by_agent_id,v.skill_name,v.approval_status,COALESCE(v.approved_space_id,''),COALESCE(v.reviewed_by,''),v.reviewed_at,v.review_comment
FROM skill_versions v LEFT JOIN skill_sources src ON src.source_id=v.source_id WHERE v.skill_id=$1 AND v.version_id=$2 FOR UPDATE OF v`, skillID, versionID), &version); err != nil {
		return Version{}, mapNotFound(err)
	}
	if version.Source != nil || version.UploadedByUserID == "" || version.UploadedByUserID != userID {
		return Version{}, ErrReviewForbidden
	}
	if currentVersionID != nil && *currentVersionID == versionID || version.ApprovalStatus != "rejected" {
		return Version{}, ErrConflict
	}
	var currentRequestID, status string
	if err = tx.QueryRow(ctx, `SELECT id,status FROM approval_requests WHERE business_type='skill_version' AND business_id=$1 AND action='publish' AND scope_type='skill_space' AND scope_id=$2 AND content_digest=$3 AND status<>'invalidated' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, versionID, spaceID, version.PackageSHA256).Scan(&currentRequestID, &status); err != nil {
		if err == pgx.ErrNoRows {
			return Version{}, ErrConflict
		}
		return Version{}, err
	}
	if currentRequestID != requestID || status != "rejected" {
		return Version{}, ErrConflict
	}
	if err = createLocalRequest(ctx, tx, versionID, spaceID, version.PackageSHA256, now); err != nil {
		return Version{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE skill_versions SET approval_status='pending',approved_space_id=NULL,reviewed_by=NULL,reviewed_at=NULL,review_comment='' WHERE version_id=$1`, versionID); err != nil {
		return Version{}, err
	}
	version.ApprovalStatus, version.ApprovedSpaceID, version.ReviewedBy, version.ReviewedAt, version.ReviewComment = "pending", "", "", nil, ""
	version.LocalApproval, err = readLocalProgress(ctx, tx, versionID, spaceID, version.PackageSHA256)
	if err != nil {
		return Version{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Version{}, err
	}
	return version, nil
}
