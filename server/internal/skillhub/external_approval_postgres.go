package skillhub

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

const approvalColumns = `id,version_id,space_id,package_sha256,template_id,COALESCE(provider_instance_id,''),initiator_user_id,initiator_external_user_id,status,COALESCE(decision,''),created_at,updated_at`

func scanApproval(row rowScanner) (ApprovalInstance, error) {
	var item ApprovalInstance
	err := row.Scan(&item.ID, &item.VersionID, &item.SpaceID, &item.PackageSHA256, &item.TemplateID, &item.ProviderInstanceID, &item.InitiatorUserID, &item.InitiatorExternalUserID, &item.Status, &item.Decision, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func mapApprovalError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrExternalApprovalConflict
	}
	return err
}

func (s *PostgresStore) latestApproval(ctx context.Context, versionID string) (*ApprovalInstance, error) {
	item, err := scanApproval(s.pool.QueryRow(ctx, `SELECT `+approvalColumns+` FROM skill_version_approval_instances WHERE version_id=$1 AND status<>'invalidated' ORDER BY created_at DESC,id DESC LIMIT 1`, versionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *PostgresStore) SetSpaceApproval(ctx context.Context, spaceID, provider, template, operator string, now time.Time) error {
	_, err := s.SetSpaceApprovers(ctx, spaceID, provider, template, nil, true, operator, now)
	return err
}

func (s *PostgresStore) BeginApproval(ctx context.Context, skillID, versionID, userID, externalUserID string, now time.Time) (ApprovalInstance, Version, Skill, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ApprovalInstance{}, Version{}, Skill{}, err
	}
	defer tx.Rollback(ctx)
	var spaceID string
	if err = tx.QueryRow(ctx, `SELECT space_id FROM skills WHERE skill_id=$1`, skillID).Scan(&spaceID); err != nil {
		return ApprovalInstance{}, Version{}, Skill{}, mapNotFound(err)
	}
	var provider, template string
	if err = tx.QueryRow(ctx, `SELECT approval_provider,external_approval_template_id FROM skill_spaces WHERE space_id=$1 FOR SHARE`, spaceID).Scan(&provider, &template); err != nil {
		return ApprovalInstance{}, Version{}, Skill{}, err
	}
	var skill Skill
	if err = scanSkill(tx.QueryRow(ctx, `SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=$1 FOR UPDATE`, skillID), &skill); err != nil {
		return ApprovalInstance{}, Version{}, Skill{}, mapNotFound(err)
	}
	if skill.SpaceID != spaceID {
		return ApprovalInstance{}, Version{}, Skill{}, ErrConflict
	}
	if provider != "dingtalk" {
		return ApprovalInstance{}, Version{}, Skill{}, ErrInvalidRequest
	}
	var version Version
	var sourceID pgtype.Text
	if err = tx.QueryRow(ctx, `SELECT version_id,skill_id,version,description,changelog,package_sha256,COALESCE(uploaded_by_user_id,''),source_id FROM skill_versions WHERE skill_id=$1 AND version_id=$2 FOR UPDATE`, skillID, versionID).Scan(&version.VersionID, &version.SkillID, &version.Version, &version.Description, &version.Changelog, &version.PackageSHA256, &version.UploadedByUserID, &sourceID); err != nil {
		return ApprovalInstance{}, Version{}, Skill{}, mapNotFound(err)
	}
	if sourceID.Valid || version.UploadedByUserID != userID || skill.CurrentVersionID != nil && *skill.CurrentVersionID == versionID {
		return ApprovalInstance{}, Version{}, Skill{}, ErrApprovalRequired
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM skill_version_approval_instances WHERE version_id=$1 AND (status IN ('submitting','running','uncertain') OR status='finished' AND decision='approved'))`, versionID).Scan(&exists); err != nil {
		return ApprovalInstance{}, Version{}, Skill{}, err
	}
	if exists {
		return ApprovalInstance{}, Version{}, Skill{}, ErrExternalApprovalConflict
	}
	item := ApprovalInstance{ID: newID("skillapproval"), VersionID: versionID, SpaceID: skill.SpaceID, PackageSHA256: version.PackageSHA256, TemplateID: template, InitiatorUserID: userID, InitiatorExternalUserID: externalUserID, Status: "submitting", CreatedAt: now, UpdatedAt: now}
	if _, err = tx.Exec(ctx, `INSERT INTO skill_version_approval_instances(id,version_id,space_id,package_sha256,template_id,initiator_user_id,initiator_external_user_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'submitting',$8,$8)`, item.ID, versionID, skill.SpaceID, version.PackageSHA256, template, userID, externalUserID, now); err != nil {
		return ApprovalInstance{}, Version{}, Skill{}, mapApprovalError(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE skill_versions SET approval_status='pending',approved_space_id=NULL,reviewed_by=NULL,reviewed_at=NULL,review_comment='' WHERE version_id=$1`, versionID); err != nil {
		return ApprovalInstance{}, Version{}, Skill{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ApprovalInstance{}, Version{}, Skill{}, err
	}
	return item, version, skill, nil
}

func (s *PostgresStore) FinishSubmission(ctx context.Context, id, providerID, status string, now time.Time) (ApprovalInstance, error) {
	if status == "running" && providerID == "" {
		return ApprovalInstance{}, ErrInvalidRequest
	}
	item, err := scanApproval(s.pool.QueryRow(ctx, `UPDATE skill_version_approval_instances SET provider_instance_id=NULLIF($2,''),status=$3,updated_at=$4 WHERE id=$1 AND status='submitting' RETURNING `+approvalColumns, id, providerID, status, now))
	if errors.Is(err, pgx.ErrNoRows) {
		return ApprovalInstance{}, ErrExternalApprovalConflict
	}
	return item, mapApprovalError(err)
}

func (s *PostgresStore) GetApproval(ctx context.Context, skillID, versionID string) (ApprovalInstance, error) {
	item, err := scanApproval(s.pool.QueryRow(ctx, `SELECT `+approvalColumns+` FROM skill_version_approval_instances WHERE version_id=$1 AND status<>'invalidated' AND version_id IN (SELECT version_id FROM skill_versions WHERE skill_id=$2) ORDER BY created_at DESC,id DESC LIMIT 1`, versionID, skillID))
	return item, mapNotFound(err)
}

func (s *PostgresStore) GetApprovalByID(ctx context.Context, id string) (ApprovalInstance, error) {
	item, err := scanApproval(s.pool.QueryRow(ctx, `SELECT `+approvalColumns+` FROM skill_version_approval_instances WHERE id=$1`, id))
	return item, mapNotFound(err)
}

func (s *PostgresStore) ResolveApproval(ctx context.Context, id, resolution, providerID string, now time.Time) (ApprovalInstance, error) {
	status := "failed"
	if resolution == "bind_instance" {
		status = "running"
	}
	item, err := scanApproval(s.pool.QueryRow(ctx, `UPDATE skill_version_approval_instances SET status=$2,provider_instance_id=CASE WHEN $2='running' THEN $3 ELSE NULL END,updated_at=$4 WHERE id=$1 AND status IN ('submitting','uncertain') RETURNING `+approvalColumns, id, status, nullableText(providerID), now))
	if errors.Is(err, pgx.ErrNoRows) {
		return ApprovalInstance{}, ErrExternalApprovalConflict
	}
	return item, mapApprovalError(err)
}

func (s *PostgresStore) ApplyApprovalResult(ctx context.Context, providerID, template, eventType, result string, now time.Time) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var skillID string
	if err = tx.QueryRow(ctx, `SELECT v.skill_id FROM skill_version_approval_instances ai JOIN skill_versions v ON v.version_id=ai.version_id WHERE ai.provider_instance_id=$1`, providerID).Scan(&skillID); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	var spaceID string
	if err = tx.QueryRow(ctx, `SELECT space_id FROM skills WHERE skill_id=$1`, skillID).Scan(&spaceID); err != nil {
		return err
	}
	var provider, currentTemplate, sha string
	if err = tx.QueryRow(ctx, `SELECT approval_provider,external_approval_template_id FROM skill_spaces WHERE space_id=$1 FOR SHARE`, spaceID).Scan(&provider, &currentTemplate); err != nil {
		return err
	}
	var actualSpace string
	if err = tx.QueryRow(ctx, `SELECT space_id FROM skills WHERE skill_id=$1 FOR UPDATE`, skillID).Scan(&actualSpace); err != nil {
		return err
	}
	if actualSpace != spaceID {
		return ErrConflict
	}
	item, err := scanApproval(tx.QueryRow(ctx, `SELECT `+approvalColumns+` FROM skill_version_approval_instances WHERE provider_instance_id=$1 FOR UPDATE`, providerID))
	if err != nil {
		return err
	}
	if item.Status != "running" || item.TemplateID != template || item.SpaceID != spaceID {
		return nil
	}
	if err = tx.QueryRow(ctx, `SELECT package_sha256 FROM skill_versions WHERE version_id=$1 FOR UPDATE`, item.VersionID).Scan(&sha); err != nil {
		return err
	}
	if provider != "dingtalk" || currentTemplate != template || sha != item.PackageSHA256 {
		return nil
	}
	status, decision := "terminated", ""
	if eventType == "finish" {
		status = "finished"
		decision = "rejected"
		if result == "agree" {
			decision = "approved"
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE skill_version_approval_instances SET status=$2,decision=NULLIF($3,''),updated_at=$4 WHERE id=$1`, item.ID, status, decision, now); err != nil {
		return err
	}
	if eventType == "finish" {
		if _, err = tx.Exec(ctx, `UPDATE skill_versions SET approval_status=$2,approved_space_id=$3,reviewed_by='dingtalk',reviewed_at=$4,review_comment='' WHERE version_id=$1`, item.VersionID, decision, spaceID, now); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
