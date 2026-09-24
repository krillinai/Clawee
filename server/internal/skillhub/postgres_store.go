package skillhub

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

type postgresPool interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type PostgresStore struct {
	pool postgresPool
}

func NewPostgresStore(pool postgresPool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

func (s *PostgresStore) CreateVersion(ctx context.Context, proposed Skill, version Version, options CreateVersionOptions) (Skill, Version, error) {
	if options.Origin != "app_upload" && options.Origin != "admin_upload" && options.Origin != "source_sync" {
		return Skill{}, Version{}, ErrInvalidRequest
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Skill{}, Version{}, err
	}
	defer tx.Rollback(ctx)
	// Serialize uploads against changes to the space's approver list.
	var lockedSpace string
	spaceID := proposed.SpaceID
	if options.Resolution == VersionResolutionTarget {
		if err = tx.QueryRow(ctx, `SELECT space_id FROM skills WHERE skill_id=$1`, options.TargetSkillID).Scan(&spaceID); err != nil {
			return Skill{}, Version{}, mapNotFound(err)
		}
	}
	if err = tx.QueryRow(ctx, `SELECT space_id FROM skill_spaces WHERE space_id=$1 FOR SHARE`, spaceID).Scan(&lockedSpace); err != nil {
		return Skill{}, Version{}, mapSpaceNotFound(err)
	}

	skill := Skill{}
	newSkill := false
	switch options.Resolution {
	case VersionResolutionByName:
		inserted, insertErr := tx.Exec(ctx, `INSERT INTO skills (skill_id,space_id,name,current_version_id,created_by,created_at,updated_at,created_by_user_id) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7) ON CONFLICT (name) DO NOTHING`, proposed.SkillID, proposed.SpaceID, proposed.Name, proposed.CreatedBy, proposed.CreatedAt, proposed.UpdatedAt, nullableText(proposed.CreatedByUserID))
		err = insertErr
		if err != nil {
			return Skill{}, Version{}, mapSkillCreateError(err)
		}
		newSkill = inserted.RowsAffected() == 1
		err = scanSkill(tx.QueryRow(ctx, `SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE name=$1 FOR UPDATE`, proposed.Name), &skill)
		if err != nil {
			return Skill{}, Version{}, err
		}
		if skill.SpaceID != proposed.SpaceID {
			return Skill{}, Version{}, ErrConflict
		}
	case VersionResolutionCreateOnly:
		err = scanSkill(tx.QueryRow(ctx, `SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE name=$1 FOR UPDATE`, proposed.Name), &skill)
		if err == nil {
			return Skill{}, Version{}, ErrConflict
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return Skill{}, Version{}, err
		}
		_, err = tx.Exec(ctx, `INSERT INTO skills (skill_id,space_id,name,current_version_id,created_by,created_at,updated_at,created_by_user_id) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)`, proposed.SkillID, proposed.SpaceID, proposed.Name, proposed.CreatedBy, proposed.CreatedAt, proposed.UpdatedAt, nullableText(proposed.CreatedByUserID))
		if err != nil {
			return Skill{}, Version{}, mapSkillCreateError(err)
		}
		skill = proposed
		newSkill = true
	case VersionResolutionTarget, VersionResolutionReplace:
		err = scanSkill(tx.QueryRow(ctx, `SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=$1 FOR UPDATE`, options.TargetSkillID), &skill)
		if err != nil {
			return Skill{}, Version{}, mapNotFound(err)
		}
		if options.Resolution == VersionResolutionTarget && skill.Name != proposed.Name {
			return Skill{}, Version{}, ErrConflict
		}
		if options.Resolution == VersionResolutionReplace {
			if skill.SpaceID != proposed.SpaceID {
				return Skill{}, Version{}, ErrConflict
			}
			var occupied bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM skills WHERE name=$1 AND skill_id<>$2)`, proposed.Name, skill.SkillID).Scan(&occupied); err != nil {
				return Skill{}, Version{}, err
			}
			if occupied {
				return Skill{}, Version{}, ErrConflict
			}
		}
	default:
		return Skill{}, Version{}, ErrInvalidRequest
	}
	if skill.SpaceID != lockedSpace {
		return Skill{}, Version{}, ErrConflict
	}

	version.SkillID = skill.SkillID
	version.SkillName, version.ApprovalStatus = proposed.Name, "pending"
	var sourceID, sourcePath, sourceCommitSHA, sourceContentSHA256 any
	if version.Source != nil {
		sourceID = version.Source.SourceID
		sourcePath = version.Source.Path
		sourceCommitSHA = version.Source.CommitSHA
		sourceContentSHA256 = version.Source.ContentSHA256
	}
	_, err = tx.Exec(ctx, `INSERT INTO skill_versions (version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at,source_id,source_path,source_commit_sha,source_content_sha256,uploaded_by_user_id,uploaded_by_agent_id,uploaded_by_name,skill_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		version.VersionID, version.SkillID, version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, version.CreatedAt,
		sourceID, sourcePath, sourceCommitSHA, sourceContentSHA256, nullableText(version.UploadedByUserID), nullableText(version.UploadedByAgentID), version.UploadedByName, version.SkillName)
	if err != nil {
		return Skill{}, Version{}, mapStoreError(err)
	}
	if err = createLocalRequest(ctx, tx, version.VersionID, skill.SpaceID, version.PackageSHA256, version.CreatedAt); err != nil {
		return Skill{}, Version{}, err
	}
	eventType, actorKind := "skill.version_uploaded", "user"
	var actorUserID any = version.UploadedByUserID
	if newSkill {
		eventType = "skill.created"
	}
	if options.Origin == "source_sync" {
		actorKind, actorUserID = "system", nil
	}
	_, err = tx.Exec(ctx, `INSERT INTO employee_ai_activity_facts (fact_id,event_type,actor_kind,actor_user_id,origin,target_id,target_name,source_system,source_event_key) VALUES ($1,$2,$3,$4,$5,$6,$7,'skillhub',$8)`,
		newID("fact"), eventType, actorKind, actorUserID, options.Origin, skill.SkillID, skill.Name, version.VersionID)
	if err != nil {
		return Skill{}, Version{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Skill{}, Version{}, mapStoreError(err)
	}
	if skill.CurrentVersionID == nil {
		skill.Description = version.Description
	}
	return skill, version, nil
}

func (s *PostgresStore) ListAdmin(ctx context.Context) ([]Skill, error) {
	rows, err := s.pool.Query(ctx, adminSkillSelect+` ORDER BY s.updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Skill{}
	for rows.Next() {
		var item Skill
		if err := scanAdminSkill(rows, &item); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	progress, err := s.listLocalProgress(ctx, items)
	if err != nil {
		return nil, err
	}
	for i := range items {
		if items[i].LatestVersion != nil {
			items[i].LatestVersion.LocalApproval = progress[items[i].LatestVersion.VersionID]
		}
	}
	return items, nil
}

func (s *PostgresStore) ListOwnPendingVersions(ctx context.Context, userID string) ([]OwnPendingVersion, error) {
	rows, err := s.pool.Query(ctx, `SELECT s.skill_id,s.space_id,s.name,v.version_id,v.version,v.created_at,sp.approval_provider,
ai.id,ai.status,COALESCE(ai.decision,''),COALESCE(ai.provider_instance_id,'')
FROM skill_versions v JOIN skills s ON s.skill_id=v.skill_id
JOIN skill_spaces sp ON sp.space_id=s.space_id
JOIN data_resource_grants g ON g.resource_type='skill_space' AND g.resource_id=s.space_id AND g.user_id=$1 AND g.action='write'
LEFT JOIN LATERAL (SELECT id,status,decision,provider_instance_id FROM skill_version_approval_instances WHERE version_id=v.version_id AND status<>'invalidated' ORDER BY created_at DESC,id DESC LIMIT 1) ai ON TRUE
WHERE v.uploaded_by_user_id=$1 AND ((sp.approval_provider='dingtalk' AND v.source_id IS NULL AND s.current_version_id IS DISTINCT FROM v.version_id) OR (sp.approval_provider='local' AND v.approval_status='pending' AND NOT EXISTS(SELECT 1 FROM approval_config_approvers ac WHERE ac.scope_type='skill_space' AND ac.scope_id=sp.space_id)))
ORDER BY v.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []OwnPendingVersion{}
	for rows.Next() {
		var item OwnPendingVersion
		var id, status, decision, providerID pgtype.Text
		if err := rows.Scan(&item.SkillID, &item.SpaceID, &item.Name, &item.VersionID, &item.Version, &item.CreatedAt, &item.ApprovalProvider, &id, &status, &decision, &providerID); err != nil {
			return nil, err
		}
		if id.Valid {
			item.ApprovalInstance = &ApprovalInstance{ID: id.String, Status: status.String, Decision: decision.String, ProviderInstanceID: providerID.String}
		}
		item.CreatedAt = item.CreatedAt.UTC()
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) DeleteUnpublished(ctx context.Context, id string) ([]Version, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var current pgtype.Text
	if err := tx.QueryRow(ctx, `SELECT current_version_id FROM skills WHERE skill_id=$1 FOR UPDATE`, id).Scan(&current); err != nil {
		return nil, mapNotFound(err)
	}
	if current.Valid {
		return nil, ErrConflict
	}
	if _, err := tx.Exec(ctx, `UPDATE skill_source_items SET skill_id=NULL,last_version_id=NULL WHERE skill_id=$1`, id); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM approval_requests WHERE business_type='skill_version' AND business_id IN (SELECT version_id FROM skill_versions WHERE skill_id=$1)`, id); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `DELETE FROM skill_versions WHERE skill_id=$1 RETURNING package_path`, id)
	if err != nil {
		return nil, err
	}
	versions := []Version{}
	for rows.Next() {
		var version Version
		if err := rows.Scan(&version.PackagePath); err != nil {
			rows.Close()
			return nil, err
		}
		versions = append(versions, version)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM skills WHERE skill_id=$1`, id); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return versions, nil
}

func (s *PostgresStore) GetAdmin(ctx context.Context, skillID string) (AdminDetail, error) {
	var skill Skill
	if err := scanAdminSkill(s.pool.QueryRow(ctx, adminSkillSelect+` WHERE s.skill_id=$1`, skillID), &skill); err != nil {
		return AdminDetail{}, mapNotFound(err)
	}
	rows, err := s.pool.Query(ctx, `SELECT v.version_id,v.skill_id,v.version,v.description,v.changelog,v.package_path,v.package_sha256,v.created_at,
v.source_id,src.repository_owner,src.repository_name,v.source_path,v.source_commit_sha,v.source_content_sha256,
v.uploaded_by_user_id,v.uploaded_by_agent_id,v.skill_name,v.approval_status,COALESCE(v.approved_space_id,''),COALESCE(v.reviewed_by,''),v.reviewed_at,v.review_comment
FROM skill_versions v
LEFT JOIN skill_sources src ON src.source_id=v.source_id
WHERE v.skill_id=$1 ORDER BY v.created_at DESC`, skillID)
	if err != nil {
		return AdminDetail{}, err
	}
	defer rows.Close()
	versions := []Version{}
	for rows.Next() {
		var version Version
		if err := scanVersionSource(rows, &version); err != nil {
			return AdminDetail{}, err
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return AdminDetail{}, err
	}
	rows.Close()
	for i := range versions {
		versions[i].ApprovalInstance, err = s.latestApproval(ctx, versions[i].VersionID)
		if err != nil {
			return AdminDetail{}, err
		}
		versions[i].LocalApproval, err = s.localProgress(ctx, versions[i].VersionID, skill.SpaceID, versions[i].PackageSHA256)
		if err != nil {
			return AdminDetail{}, err
		}
	}
	return AdminDetail{Skill: skill, Versions: versions}, nil
}

func (s *PostgresStore) ListPublished(ctx context.Context) ([]PublishedItem, error) {
	rows, err := s.pool.Query(ctx, publishedSelect+` ORDER BY s.updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []PublishedItem{}
	for rows.Next() {
		var detail PublishedDetail
		if err := scanPublished(rows, &detail); err != nil {
			return nil, err
		}
		items = append(items, detail.PublishedItem)
	}
	return items, rows.Err()
}

func (s *PostgresStore) ListPublishedForUser(ctx context.Context, userID, spaceID string) ([]PublishedItem, error) {
	query := publishedSelect + ` AND EXISTS (
		SELECT 1 FROM data_resource_grants g
		WHERE g.user_id=$1 AND g.resource_type=$2 AND g.resource_id=s.space_id AND g.action=$3
	)`
	args := []any{userID, ResourceTypeSpace, SpaceActionRead}
	if spaceID != "" {
		query += ` AND s.space_id=$4`
		args = append(args, spaceID)
	}
	rows, err := s.pool.Query(ctx, query+` ORDER BY s.updated_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []PublishedItem{}
	for rows.Next() {
		var detail PublishedDetail
		if err := scanPublished(rows, &detail); err != nil {
			return nil, err
		}
		items = append(items, detail.PublishedItem)
	}
	return items, rows.Err()
}

func (s *PostgresStore) EnrichPublished(ctx context.Context, items []PublishedItem) ([]PublishedItem, error) {
	if len(items) == 0 {
		return items, nil
	}
	ids := make([]string, 0, len(items))
	byID := make(map[string]int, len(items))
	for index, item := range items {
		ids = append(ids, item.SkillID)
		byID[item.SkillID] = index
		items[index].Contributors = nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT s.skill_id, s.created_by_user_id, COALESCE(NULLIF(btrim(creator.name), ''), s.created_by),
		       contributor.user_id, COALESCE(NULLIF(btrim(account.name), ''), contributor.name, '企业成员')
		FROM skills s
		LEFT JOIN accounts creator ON creator.user_id=s.created_by_user_id
		LEFT JOIN LATERAL (
		    SELECT v.uploaded_by_user_id AS user_id, MAX(v.created_at) AS last_updated_at,
		           (array_agg(NULLIF(v.uploaded_by_name, '') ORDER BY v.created_at DESC, v.version_id DESC))[1] AS name
		    FROM skill_versions v
		    WHERE v.skill_id=s.skill_id AND v.uploaded_by_user_id IS NOT NULL
		      AND v.uploaded_by_user_id IS DISTINCT FROM s.created_by_user_id
		    GROUP BY v.uploaded_by_user_id
		) contributor ON TRUE
		LEFT JOIN accounts account ON account.user_id=contributor.user_id
		WHERE s.skill_id=ANY($1)
		ORDER BY s.skill_id, contributor.last_updated_at DESC, contributor.user_id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var skillID, creatorName string
		var creatorID, userID, name pgtype.Text
		if err := rows.Scan(&skillID, &creatorID, &creatorName, &userID, &name); err != nil {
			return nil, err
		}
		index, ok := byID[skillID]
		if !ok {
			continue
		}
		creator := newSkillParticipant(skillID, creatorID.String, creatorName)
		items[index].Creator = &creator
		if userID.Valid {
			items[index].Contributors = append(items[index].Contributors, newSkillParticipant(skillID, userID.String, name.String))
		}
	}
	return items, rows.Err()
}

func (s *PostgresStore) GetPublished(ctx context.Context, skillID string) (PublishedDetail, error) {
	var detail PublishedDetail
	if err := scanPublished(s.pool.QueryRow(ctx, publishedSelect+` AND s.skill_id=$1`, skillID), &detail); err != nil {
		return PublishedDetail{}, mapNotFound(err)
	}
	return detail, nil
}

func (s *PostgresStore) SetCurrentVersion(ctx context.Context, skillID, versionID string, now time.Time) (Skill, Version, error) {
	return s.setCurrentVersion(ctx, skillID, versionID, "", now)
}

func (s *PostgresStore) PublishOwnVersion(ctx context.Context, skillID, versionID, userID string, now time.Time) (Skill, Version, error) {
	return s.setCurrentVersion(ctx, skillID, versionID, userID, now)
}

func (s *PostgresStore) setCurrentVersion(ctx context.Context, skillID, versionID, userID string, now time.Time) (Skill, Version, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Skill{}, Version{}, err
	}
	defer tx.Rollback(ctx)
	var spaceID string
	if err = tx.QueryRow(ctx, `SELECT space_id FROM skills WHERE skill_id=$1`, skillID).Scan(&spaceID); err != nil {
		return Skill{}, Version{}, mapNotFound(err)
	}
	var provider, template string
	if err = tx.QueryRow(ctx, `SELECT approval_provider,external_approval_template_id FROM skill_spaces WHERE space_id=$1 FOR SHARE`, spaceID).Scan(&provider, &template); err != nil {
		return Skill{}, Version{}, err
	}
	var skill Skill
	if err := scanSkill(tx.QueryRow(ctx, `SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=$1 FOR UPDATE`, skillID), &skill); err != nil {
		return Skill{}, Version{}, mapNotFound(err)
	}
	var version Version
	if err := scanVersion(tx.QueryRow(ctx, `SELECT version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at FROM skill_versions WHERE version_id=$1`, versionID), &version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Skill{}, Version{}, ErrNotFound
		}
		return Skill{}, Version{}, err
	}
	if version.SkillID != skillID {
		return Skill{}, Version{}, ErrConflict
	}
	if skill.SpaceID != spaceID {
		return Skill{}, Version{}, ErrConflict
	}
	var hasApprovers bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$1)`, spaceID).Scan(&hasApprovers); err != nil {
		return Skill{}, Version{}, err
	}
	if provider == "dingtalk" && userID != "" {
		return Skill{}, Version{}, ErrApprovalRequired
	}
	if provider == "local" && !hasApprovers && userID == "" {
		return Skill{}, Version{}, ErrApprovalRequired
	}
	if provider == "local" && hasApprovers {
		if userID != "" {
			return Skill{}, Version{}, ErrApprovalRequired
		}
	}
	var sourceID pgtype.Text
	if err := tx.QueryRow(ctx, `SELECT skill_name,approval_status,COALESCE(approved_space_id,''),source_id FROM skill_versions WHERE version_id=$1 FOR UPDATE`, versionID).Scan(&version.SkillName, &version.ApprovalStatus, &version.ApprovedSpaceID, &sourceID); err != nil {
		return Skill{}, Version{}, err
	}
	if provider == "dingtalk" {
		if sourceID.Valid {
			if _, err := tx.Exec(ctx, `UPDATE skill_versions SET approval_status='approved',approved_space_id=$2,reviewed_at=$3 WHERE version_id=$1`, versionID, skill.SpaceID, now); err != nil {
				return Skill{}, Version{}, err
			}
			version.ApprovalStatus, version.ApprovedSpaceID, version.ReviewedAt = "approved", skill.SpaceID, &now
		} else {
			var valid bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM skill_version_approval_instances WHERE version_id=$1 AND space_id=$2 AND template_id=$3 AND package_sha256=$4 AND status='finished' AND decision='approved')`, versionID, skill.SpaceID, template, version.PackageSHA256).Scan(&valid); err != nil {
				return Skill{}, Version{}, err
			}
			if !valid || version.ApprovalStatus != "approved" || version.ApprovedSpaceID != skill.SpaceID {
				return Skill{}, Version{}, ErrApprovalRequired
			}
		}
	} else if !hasApprovers && userID != "" {
		var uploader string
		if err := tx.QueryRow(ctx, `SELECT COALESCE(uploaded_by_user_id,'') FROM skill_versions WHERE version_id=$1`, versionID).Scan(&uploader); err != nil {
			return Skill{}, Version{}, err
		}
		if uploader != userID {
			return Skill{}, Version{}, ErrSelfPublishForbidden
		}
		if version.ApprovalStatus == "rejected" {
			return Skill{}, Version{}, ErrApprovalRequired
		}
		if _, err := tx.Exec(ctx, `UPDATE skill_versions SET approval_status='approved',approved_space_id=$2,reviewed_by=$3,reviewed_at=$4 WHERE version_id=$1`, versionID, skill.SpaceID, userID, now); err != nil {
			return Skill{}, Version{}, err
		}
		version.ApprovalStatus, version.ApprovedSpaceID, version.ReviewedBy, version.ReviewedAt = "approved", skill.SpaceID, userID, &now
	} else if version.ApprovalStatus != "approved" || version.ApprovedSpaceID != skill.SpaceID {
		return Skill{}, Version{}, ErrApprovalRequired
	}
	if provider == "local" && hasApprovers {
		var valid bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM approval_requests WHERE business_type='skill_version' AND business_id=$1 AND action='publish' AND scope_type='skill_space' AND scope_id=$2 AND content_digest=$3 AND status='approved')`, versionID, skill.SpaceID, version.PackageSHA256).Scan(&valid); err != nil {
			return Skill{}, Version{}, err
		}
		if !valid {
			return Skill{}, Version{}, ErrApprovalRequired
		}
	}
	if version.SkillName != "" && version.SkillName != skill.Name {
		if _, err := tx.Exec(ctx, `UPDATE skills SET name=$2 WHERE skill_id=$1`, skillID, version.SkillName); err != nil {
			return Skill{}, Version{}, mapStoreError(err)
		}
		skill.Name = version.SkillName
	}
	if skill.CurrentVersionID == nil || *skill.CurrentVersionID != versionID {
		previous := skill.CurrentVersionID
		if _, err := tx.Exec(ctx, `UPDATE skills SET current_version_id=$2,updated_at=$3 WHERE skill_id=$1`, skillID, versionID, now); err != nil {
			return Skill{}, Version{}, mapStoreError(err)
		}
		if provider == "local" && hasApprovers && previous != nil {
			var digest string
			if err := tx.QueryRow(ctx, `SELECT package_sha256 FROM skill_versions WHERE version_id=$1 FOR UPDATE`, *previous).Scan(&digest); err != nil {
				return Skill{}, Version{}, err
			}
			if err := resetStaleLocalRequest(ctx, tx, *previous, spaceID, digest, now); err != nil {
				return Skill{}, Version{}, err
			}
		}
		value := versionID
		skill.CurrentVersionID = &value
		skill.UpdatedAt = now
	}
	if err := tx.Commit(ctx); err != nil {
		return Skill{}, Version{}, err
	}
	skill.Description = version.Description
	return skill, version, nil
}

func (s *PostgresStore) MoveSkillsToSpace(ctx context.Context, skillIDs []string, targetSpaceID string, now time.Time) (SkillSpaceMoveResult, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SkillSpaceMoveResult{}, err
	}
	defer tx.Rollback(ctx)
	var lockedSpaceID string
	if err := tx.QueryRow(ctx, `SELECT space_id FROM skill_spaces WHERE space_id=$1 FOR SHARE`, targetSpaceID).Scan(&lockedSpaceID); err != nil {
		return SkillSpaceMoveResult{}, mapSpaceNotFound(err)
	}
	rows, err := tx.Query(ctx, `SELECT skill_id FROM skills WHERE skill_id=ANY($1) FOR UPDATE`, skillIDs)
	if err != nil {
		return SkillSpaceMoveResult{}, err
	}
	found := int64(0)
	for rows.Next() {
		var skillID string
		if err := rows.Scan(&skillID); err != nil {
			rows.Close()
			return SkillSpaceMoveResult{}, err
		}
		found++
	}
	rowsErr := rows.Err()
	rows.Close()
	if rowsErr != nil {
		return SkillSpaceMoveResult{}, rowsErr
	}
	if found != int64(len(skillIDs)) {
		return SkillSpaceMoveResult{}, ErrNotFound
	}
	var active bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM skill_version_approval_instances ai JOIN skill_versions v ON v.version_id=ai.version_id JOIN skills s ON s.skill_id=v.skill_id WHERE s.skill_id=ANY($1) AND s.space_id<>$2 AND ai.status IN ('submitting','running','uncertain'))`, skillIDs, targetSpaceID).Scan(&active); err != nil {
		return SkillSpaceMoveResult{}, err
	}
	if active {
		return SkillSpaceMoveResult{}, ErrExternalApprovalConflict
	}
	if _, err := tx.Exec(ctx, `UPDATE skill_version_approval_instances SET status='invalidated',updated_at=$3 WHERE version_id IN (SELECT v.version_id FROM skill_versions v JOIN skills s ON s.skill_id=v.skill_id WHERE s.skill_id=ANY($1) AND s.space_id<>$2) AND status<>'invalidated'`, skillIDs, targetSpaceID, now); err != nil {
		return SkillSpaceMoveResult{}, err
	}
	var movedIDs []string
	rows, err = tx.Query(ctx, `SELECT v.version_id FROM skill_versions v JOIN skills s ON s.skill_id=v.skill_id WHERE s.skill_id=ANY($1) AND s.space_id<>$2`, skillIDs, targetSpaceID)
	if err != nil {
		return SkillSpaceMoveResult{}, err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return SkillSpaceMoveResult{}, err
		}
		movedIDs = append(movedIDs, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return SkillSpaceMoveResult{}, err
	}
	if err = invalidateLocalRequests(ctx, tx, movedIDs, now); err != nil {
		return SkillSpaceMoveResult{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE skill_versions SET approval_status='pending',approved_space_id=NULL,reviewed_by=NULL,reviewed_at=NULL,review_comment='' WHERE skill_id IN (SELECT skill_id FROM skills WHERE skill_id=ANY($1) AND space_id<>$2)`, skillIDs, targetSpaceID); err != nil {
		return SkillSpaceMoveResult{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE skills SET space_id=$2,current_version_id=NULL,updated_at=$3 WHERE skill_id=ANY($1) AND space_id<>$2`, skillIDs, targetSpaceID, now)
	if err != nil {
		return SkillSpaceMoveResult{}, mapStoreError(err)
	}
	for _, id := range movedIDs {
		var digest string
		if err = tx.QueryRow(ctx, `SELECT package_sha256 FROM skill_versions WHERE version_id=$1`, id).Scan(&digest); err != nil {
			return SkillSpaceMoveResult{}, err
		}
		if err = createLocalRequest(ctx, tx, id, targetSpaceID, digest, now); err != nil {
			return SkillSpaceMoveResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return SkillSpaceMoveResult{}, err
	}
	moved := tag.RowsAffected()
	return SkillSpaceMoveResult{TargetSpaceID: targetSpaceID, MovedCount: moved, UnchangedCount: int64(len(skillIDs)) - moved}, nil
}

func (s *PostgresStore) ClearCurrentVersion(ctx context.Context, skillID string, now time.Time) (*Version, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var spaceID, provider string
	if err = tx.QueryRow(ctx, `SELECT space_id FROM skills WHERE skill_id=$1`, skillID).Scan(&spaceID); err != nil {
		return nil, mapNotFound(err)
	}
	if err = tx.QueryRow(ctx, `SELECT approval_provider FROM skill_spaces WHERE space_id=$1 FOR SHARE`, spaceID).Scan(&provider); err != nil {
		return nil, err
	}
	var current pgtype.Text
	var actualSpace string
	if err := tx.QueryRow(ctx, `SELECT current_version_id,space_id FROM skills WHERE skill_id=$1 FOR UPDATE`, skillID).Scan(&current, &actualSpace); err != nil {
		return nil, mapNotFound(err)
	}
	if actualSpace != spaceID {
		return nil, ErrConflict
	}
	var cleared *Version
	if current.Valid {
		var version Version
		if err := scanVersion(tx.QueryRow(ctx, `SELECT version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at FROM skill_versions WHERE skill_id=$1 AND version_id=$2`, skillID, current.String), &version); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE skills SET current_version_id=NULL,updated_at=$2 WHERE skill_id=$1`, skillID, now); err != nil {
			return nil, err
		}
		if provider == "local" {
			var hasApprovers bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$1)`, spaceID).Scan(&hasApprovers); err != nil {
				return nil, err
			}
			if hasApprovers {
				if err = resetStaleLocalRequest(ctx, tx, version.VersionID, spaceID, version.PackageSHA256, now); err != nil {
					return nil, err
				}
			}
		}
		cleared = &version
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return cleared, nil
}

const adminSkillSelect = `
SELECT s.skill_id,s.space_id,sp.name,s.name,COALESCE(cv.description,lv.description,''),s.current_version_id,s.created_by,s.created_at,s.updated_at,
COALESCE(lv.version_id,''),COALESCE(lv.version,''),COALESCE(lv.approval_status,''),COALESCE(lv.uploaded_by_user_id,''),COALESCE(lv.package_sha256,'')
FROM skills s
JOIN skill_spaces sp ON sp.space_id=s.space_id
LEFT JOIN skill_versions cv ON cv.skill_id=s.skill_id AND cv.version_id=s.current_version_id
LEFT JOIN LATERAL (
  SELECT version_id,version,description,approval_status,uploaded_by_user_id,package_sha256 FROM skill_versions WHERE skill_id=s.skill_id ORDER BY created_at DESC LIMIT 1
) lv ON TRUE`

const publishedSelect = `
SELECT s.skill_id,s.space_id,sp.name,s.name,v.description,v.version_id,v.version,v.package_sha256,s.updated_at,v.changelog,v.package_path
FROM skills s
JOIN skill_spaces sp ON sp.space_id=s.space_id
JOIN skill_versions v ON v.skill_id=s.skill_id AND v.version_id=s.current_version_id
WHERE s.current_version_id IS NOT NULL AND v.approval_status='approved' AND v.approved_space_id=s.space_id`

type rowScanner interface {
	Scan(...any) error
}

func scanSkill(row rowScanner, skill *Skill) error {
	var current pgtype.Text
	if err := row.Scan(&skill.SkillID, &skill.SpaceID, &skill.Name, &current, &skill.CreatedBy, &skill.CreatedAt, &skill.UpdatedAt); err != nil {
		return err
	}
	skill.CurrentVersionID = nullableString(current)
	skill.CreatedAt = skill.CreatedAt.UTC()
	skill.UpdatedAt = skill.UpdatedAt.UTC()
	return nil
}

func scanAdminSkill(row rowScanner, skill *Skill) error {
	var current pgtype.Text
	var latest SkillLatestVersion
	if err := row.Scan(&skill.SkillID, &skill.SpaceID, &skill.SpaceName, &skill.Name, &skill.Description, &current, &skill.CreatedBy, &skill.CreatedAt, &skill.UpdatedAt, &latest.VersionID, &latest.Version, &latest.ApprovalStatus, &latest.UploadedByUserID, &latest.PackageSHA256); err != nil {
		return err
	}
	if latest.VersionID != "" {
		skill.LatestVersion = &latest
	}
	skill.CurrentVersionID = nullableString(current)
	skill.CreatedAt = skill.CreatedAt.UTC()
	skill.UpdatedAt = skill.UpdatedAt.UTC()
	return nil
}

func scanVersion(row rowScanner, version *Version) error {
	if err := row.Scan(&version.VersionID, &version.SkillID, &version.Version, &version.Description, &version.Changelog, &version.PackagePath, &version.PackageSHA256, &version.CreatedAt); err != nil {
		return err
	}
	version.CreatedAt = version.CreatedAt.UTC()
	return nil
}

func scanVersionSource(row rowScanner, version *Version) error {
	var sourceID, repositoryOwner, repositoryName, sourcePath, sourceCommitSHA, sourceContentSHA256, uploadedByUserID, uploadedByAgentID pgtype.Text
	var reviewedAt pgtype.Timestamptz
	if err := row.Scan(
		&version.VersionID, &version.SkillID, &version.Version, &version.Description, &version.Changelog, &version.PackagePath, &version.PackageSHA256, &version.CreatedAt,
		&sourceID, &repositoryOwner, &repositoryName, &sourcePath, &sourceCommitSHA, &sourceContentSHA256, &uploadedByUserID, &uploadedByAgentID,
		&version.SkillName, &version.ApprovalStatus, &version.ApprovedSpaceID, &version.ReviewedBy, &reviewedAt, &version.ReviewComment,
	); err != nil {
		return err
	}
	if uploadedByUserID.Valid {
		version.UploadedByUserID = uploadedByUserID.String
	}
	if reviewedAt.Valid {
		now := reviewedAt.Time.UTC()
		version.ReviewedAt = &now
	}
	if uploadedByAgentID.Valid {
		version.UploadedByAgentID = uploadedByAgentID.String
	}
	if sourceID.Valid {
		version.Source = &VersionSourceEvidence{
			SourceID: sourceID.String, RepositoryOwner: repositoryOwner.String, RepositoryName: repositoryName.String,
			Path: sourcePath.String, CommitSHA: sourceCommitSHA.String, ContentSHA256: sourceContentSHA256.String,
		}
	}
	version.CreatedAt = version.CreatedAt.UTC()
	return nil
}

func scanPublished(row rowScanner, detail *PublishedDetail) error {
	if err := row.Scan(&detail.SkillID, &detail.SpaceID, &detail.SpaceName, &detail.Name, &detail.Description, &detail.VersionID, &detail.Version, &detail.PackageSHA256, &detail.UpdatedAt, &detail.Changelog, &detail.PackagePath); err != nil {
		return err
	}
	detail.UpdatedAt = detail.UpdatedAt.UTC()
	return nil
}

func nullableString(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func mapNotFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func mapStoreError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23503") {
		return ErrConflict
	}
	return err
}

func mapSkillCreateError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" && pgErr.ConstraintName == "skills_space_id_fkey" {
		return ErrSpaceNotFound
	}
	return mapStoreError(err)
}
