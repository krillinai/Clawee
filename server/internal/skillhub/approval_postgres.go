package skillhub

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *PostgresStore) SetSpaceApprovers(ctx context.Context, spaceID, provider, template string, userIDs []string, confirmed bool, operator string, now time.Time) (int64, error) {
	return s.SetSpaceApprovalSubjects(ctx, spaceID, provider, template, userIDs, nil, confirmed, operator, now)
}

func (s *PostgresStore) SetSpaceApprovalSubjects(ctx context.Context, spaceID, provider, template string, userIDs, roleIDs []string, confirmed bool, operator string, now time.Time) (int64, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var oldProvider, oldTemplate string
	if err := tx.QueryRow(ctx, `SELECT approval_provider,external_approval_template_id FROM skill_spaces WHERE space_id=$1 FOR UPDATE`, spaceID).Scan(&oldProvider, &oldTemplate); err != nil {
		return 0, mapSpaceNotFound(err)
	}
	if provider == "local" {
		template = ""
	} else {
		if len(roleIDs) != 0 {
			return 0, ErrInvalidRequest
		}
		userIDs = nil
	}
	rows, err := tx.Query(ctx, `SELECT user_id FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$1 ORDER BY user_id`, spaceID)
	if err != nil {
		return 0, err
	}
	oldIDs := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		oldIDs = append(oldIDs, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	var oldRoleIDs []string
	if err = tx.QueryRow(ctx, `SELECT ARRAY(SELECT role_id FROM approval_config_roles WHERE scope_type='skill_space' AND scope_id=$1 ORDER BY role_id)`, spaceID).Scan(&oldRoleIDs); err != nil {
		return 0, err
	}
	if oldProvider == provider && oldTemplate == template && sameIDSet(oldIDs, userIDs) && sameIDSet(oldRoleIDs, roleIDs) {
		return 0, nil
	}
	for _, id := range userIDs {
		var allowed bool
		err = tx.QueryRow(ctx, `SELECT status='active' AND EXISTS(SELECT 1 FROM effective_data_resource_permissions WHERE resource_type='skill_space' AND resource_id=$2 AND action='read' AND user_id=$1) FROM accounts WHERE user_id=$1 FOR SHARE`, id, spaceID).Scan(&allowed)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && !allowed {
			return 0, ErrMemberNotFound
		}
		if err != nil {
			return 0, err
		}
	}
	for _, id := range roleIDs {
		var found string
		if err = tx.QueryRow(ctx, `SELECT role_id FROM rbac_roles WHERE role_id=$1 FOR SHARE`, id).Scan(&found); errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrInvalidRequest
		} else if err != nil {
			return 0, err
		}
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM skill_version_approval_instances ai JOIN skill_versions v ON v.version_id=ai.version_id JOIN skills s ON s.skill_id=v.skill_id WHERE s.space_id=$1 AND ai.status IN ('submitting','running','uncertain'))`, spaceID).Scan(&active); err != nil {
		return 0, err
	}
	if active && (oldProvider != provider || oldTemplate != template) {
		return 0, ErrExternalApprovalConflict
	}
	rows, err = tx.Query(ctx, `SELECT v.version_id,v.package_sha256 FROM skill_versions v JOIN skills s ON s.skill_id=v.skill_id WHERE s.space_id=$1 AND s.current_version_id IS DISTINCT FROM v.version_id ORDER BY s.skill_id,v.version_id FOR UPDATE OF s,v`, spaceID)
	if err != nil {
		return 0, err
	}
	type pendingVersion struct{ id, digest string }
	versions := []pendingVersion{}
	ids := []string{}
	for rows.Next() {
		var v pendingVersion
		if err := rows.Scan(&v.id, &v.digest); err != nil {
			rows.Close()
			return 0, err
		}
		versions = append(versions, v)
		ids = append(ids, v.id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	if len(versions) > 0 && !confirmed {
		return int64(len(versions)), nil
	}
	if _, err = tx.Exec(ctx, `UPDATE skill_version_approval_instances SET status='invalidated',updated_at=$2 WHERE space_id=$1 AND status<>'invalidated'`, spaceID, now); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `UPDATE approval_requests SET status='invalidated',finished_at=$2 WHERE business_type='skill_version' AND action='publish' AND scope_type='skill_space' AND scope_id=$1 AND status<>'invalidated' AND business_id IN (SELECT v.version_id FROM skill_versions v JOIN skills s ON s.skill_id=v.skill_id WHERE s.space_id=$1 AND s.current_version_id IS DISTINCT FROM v.version_id)`, spaceID, now); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$1`, spaceID); err != nil {
		return 0, err
	}
	for _, id := range userIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO approval_config_approvers(scope_type,scope_id,user_id) VALUES('skill_space',$1,$2)`, spaceID, id); err != nil {
			return 0, err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM approval_config_roles WHERE scope_type='skill_space' AND scope_id=$1`, spaceID); err != nil {
		return 0, err
	}
	for _, id := range roleIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO approval_config_roles(scope_type,scope_id,role_id) VALUES('skill_space',$1,$2)`, spaceID, id); err != nil {
			return 0, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE skill_versions SET approval_status='pending',approved_space_id=NULL,reviewed_by=NULL,reviewed_at=NULL,review_comment='' WHERE version_id=ANY($1)`, ids); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `UPDATE skill_spaces SET approval_provider=$2,external_approval_template_id=$3,updated_by=$4,updated_at=$5 WHERE space_id=$1`, spaceID, provider, template, operator, now); err != nil {
		return 0, err
	}
	if provider == "local" {
		for _, v := range versions {
			if err = createLocalRequest(ctx, tx, v.id, spaceID, v.digest, now); err != nil {
				return 0, err
			}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int64(len(versions)), nil
}

func sameIDSet(oldIDs, newIDs []string) bool {
	if len(oldIDs) != len(newIDs) {
		return false
	}
	set := map[string]bool{}
	for _, id := range oldIDs {
		set[id] = true
	}
	for _, id := range newIDs {
		if !set[id] {
			return false
		}
	}
	return true
}

func (s *PostgresStore) ReviewVersion(ctx context.Context, skillID, versionID, reviewer string, approve bool, comment string, input ReviewInput, now time.Time) (Version, error) {
	if err := validateReview(approve, comment, input); err != nil {
		return Version{}, err
	}
	input.Scores = cloneScores(input.Scores)
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
	if err = tx.QueryRow(ctx, `SELECT approval_provider FROM skill_spaces WHERE space_id=$1 FOR SHARE`, spaceID).Scan(&provider); err != nil {
		return Version{}, err
	}
	if provider != "local" {
		return Version{}, ErrReviewForbidden
	}
	var actualSpace string
	if err = tx.QueryRow(ctx, `SELECT space_id FROM skills WHERE skill_id=$1 FOR UPDATE`, skillID).Scan(&actualSpace); err != nil {
		return Version{}, mapNotFound(err)
	}
	if actualSpace != spaceID {
		return Version{}, ErrConflict
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT status='active' AND EXISTS(SELECT 1 FROM effective_data_resource_permissions WHERE user_id=$1 AND resource_type='skill_space' AND resource_id=$2 AND action='read') FROM accounts WHERE user_id=$1 FOR SHARE`, reviewer, spaceID).Scan(&active); err != nil || !active {
		return Version{}, ErrReviewForbidden
	}
	var version Version
	if err = scanVersionSource(tx.QueryRow(ctx, `SELECT v.version_id,v.skill_id,v.version,v.description,v.changelog,v.package_path,v.package_sha256,v.created_at,
v.source_id,src.repository_owner,src.repository_name,v.source_path,v.source_commit_sha,v.source_content_sha256,
v.uploaded_by_user_id,v.uploaded_by_agent_id,v.skill_name,v.approval_status,COALESCE(v.approved_space_id,''),COALESCE(v.reviewed_by,''),v.reviewed_at,v.review_comment
FROM skill_versions v LEFT JOIN skill_sources src ON src.source_id=v.source_id WHERE v.skill_id=$1 AND v.version_id=$2 FOR UPDATE OF v`, skillID, versionID), &version); err != nil {
		return Version{}, mapNotFound(err)
	}
	var requestID, standard string
	err = tx.QueryRow(ctx, `SELECT id,COALESCE(scoring_standard_version,'') FROM approval_requests WHERE business_type='skill_version' AND business_id=$1 AND action='publish' AND scope_type='skill_space' AND scope_id=$2 AND content_digest=$3 AND status='pending' FOR UPDATE`, versionID, spaceID, version.PackageSHA256).Scan(&requestID, &standard)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if lookupErr := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM approval_requests WHERE business_type='skill_version' AND business_id=$1 AND action='publish' AND (status<>'invalidated' OR id=$2))`, versionID, input.RequestID).Scan(&exists); lookupErr != nil {
			return Version{}, lookupErr
		}
		if !exists {
			return Version{}, ErrReviewForbidden
		}
		return Version{}, ErrConflict
	}
	if err != nil {
		return Version{}, err
	}
	if requestID != input.RequestID || standard != "" && standard != manualScoringStandard {
		return Version{}, ErrConflict
	}
	var member bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM approval_request_approvers WHERE request_id=$1 AND user_id=$2)`, requestID, reviewer).Scan(&member); err != nil {
		return Version{}, err
	}
	if !member {
		return Version{}, ErrReviewForbidden
	}
	decision := "rejected"
	if approve {
		decision = "approved"
	}
	values := scoreValues(input.Scores)
	tag, err := tx.Exec(ctx, `UPDATE approval_request_approvers SET status=$3,comment=$4,decided_at=$5,scenario_value=$6,result_effectiveness=$7,ease_of_use=$8,reuse_value=$9 WHERE request_id=$1 AND user_id=$2 AND status='pending'`, requestID, reviewer, decision, comment, now, values[0], values[1], values[2], values[3])
	if err != nil {
		return Version{}, err
	}
	if tag.RowsAffected() == 0 {
		return Version{}, ErrConflict
	}
	if standard == "" && hasScores(input.Scores) {
		if _, err = tx.Exec(ctx, `UPDATE approval_requests SET scoring_standard_version=$2 WHERE id=$1`, requestID, manualScoringStandard); err != nil {
			return Version{}, err
		}
	}
	var remaining int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM approval_request_approvers WHERE request_id=$1 AND status='pending'`, requestID).Scan(&remaining); err != nil {
		return Version{}, err
	}
	status := "pending"
	if !approve {
		status = "rejected"
	} else if remaining == 0 {
		status = "approved"
	}
	if status != "pending" {
		if _, err = tx.Exec(ctx, `UPDATE approval_requests SET status=$2,finished_at=$3 WHERE id=$1`, requestID, status, now); err != nil {
			return Version{}, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE skill_versions SET approval_status=$2,approved_space_id=CASE WHEN $2='approved' THEN $3 ELSE NULL END,reviewed_by=CASE WHEN $2='pending' THEN NULL ELSE $4 END,reviewed_at=CASE WHEN $2='pending' THEN NULL ELSE $5::timestamptz END,review_comment=CASE WHEN $2='pending' THEN '' ELSE $6 END WHERE version_id=$1`, versionID, status, spaceID, reviewer, now, comment); err != nil {
		return Version{}, err
	}
	version.LocalApproval, err = readLocalProgress(ctx, tx, versionID, spaceID, version.PackageSHA256)
	if err != nil {
		return Version{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Version{}, err
	}
	version.ApprovalStatus = status
	if status == "approved" {
		version.ApprovedSpaceID = spaceID
	}
	if status != "pending" {
		version.ReviewedBy, version.ReviewedAt, version.ReviewComment = reviewer, &now, comment
	}
	return version, nil
}
