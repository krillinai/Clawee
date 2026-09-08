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
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Skill{}, Version{}, err
	}
	defer tx.Rollback(ctx)

	skill := Skill{}
	switch options.Resolution {
	case VersionResolutionByName:
		_, err = tx.Exec(ctx, `INSERT INTO skills (skill_id,space_id,name,current_version_id,created_by,created_at,updated_at) VALUES ($1,$2,$3,NULL,$4,$5,$6) ON CONFLICT (name) DO NOTHING`, proposed.SkillID, proposed.SpaceID, proposed.Name, proposed.CreatedBy, proposed.CreatedAt, proposed.UpdatedAt)
		if err != nil {
			return Skill{}, Version{}, mapSkillCreateError(err)
		}
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
		_, err = tx.Exec(ctx, `INSERT INTO skills (skill_id,space_id,name,current_version_id,created_by,created_at,updated_at) VALUES ($1,$2,$3,NULL,$4,$5,$6)`, proposed.SkillID, proposed.SpaceID, proposed.Name, proposed.CreatedBy, proposed.CreatedAt, proposed.UpdatedAt)
		if err != nil {
			return Skill{}, Version{}, mapSkillCreateError(err)
		}
		skill = proposed
	case VersionResolutionTarget:
		err = scanSkill(tx.QueryRow(ctx, `SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=$1 FOR UPDATE`, options.TargetSkillID), &skill)
		if err != nil {
			return Skill{}, Version{}, mapNotFound(err)
		}
		if skill.Name != proposed.Name {
			return Skill{}, Version{}, ErrConflict
		}
	default:
		return Skill{}, Version{}, ErrInvalidRequest
	}

	version.SkillID = skill.SkillID
	var sourceID, sourcePath, sourceCommitSHA, sourceContentSHA256 any
	if version.Source != nil {
		sourceID = version.Source.SourceID
		sourcePath = version.Source.Path
		sourceCommitSHA = version.Source.CommitSHA
		sourceContentSHA256 = version.Source.ContentSHA256
	}
	_, err = tx.Exec(ctx, `INSERT INTO skill_versions (version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at,source_id,source_path,source_commit_sha,source_content_sha256,uploaded_by_user_id,uploaded_by_agent_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		version.VersionID, version.SkillID, version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, version.CreatedAt,
		sourceID, sourcePath, sourceCommitSHA, sourceContentSHA256, nullableText(version.UploadedByUserID), nullableText(version.UploadedByAgentID))
	if err != nil {
		return Skill{}, Version{}, mapStoreError(err)
	}
	if options.Publish {
		_, err = tx.Exec(ctx, `UPDATE skills SET current_version_id=$2,updated_at=$3 WHERE skill_id=$1`, skill.SkillID, version.VersionID, version.CreatedAt)
		if err != nil {
			return Skill{}, Version{}, err
		}
		currentVersionID := version.VersionID
		skill.CurrentVersionID = &currentVersionID
		skill.UpdatedAt = version.CreatedAt
	}
	if err := tx.Commit(ctx); err != nil {
		return Skill{}, Version{}, mapStoreError(err)
	}
	if options.Publish || skill.CurrentVersionID == nil {
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
	return items, rows.Err()
}

func (s *PostgresStore) GetAdmin(ctx context.Context, skillID string) (AdminDetail, error) {
	var skill Skill
	if err := scanAdminSkill(s.pool.QueryRow(ctx, adminSkillSelect+` WHERE s.skill_id=$1`, skillID), &skill); err != nil {
		return AdminDetail{}, mapNotFound(err)
	}
	rows, err := s.pool.Query(ctx, `SELECT v.version_id,v.skill_id,v.version,v.description,v.changelog,v.package_path,v.package_sha256,v.created_at,
v.source_id,src.repository_owner,src.repository_name,v.source_path,v.source_commit_sha,v.source_content_sha256,
v.uploaded_by_user_id,v.uploaded_by_agent_id
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

func (s *PostgresStore) ListPublishedForUser(ctx context.Context, userID string) ([]PublishedItem, error) {
	rows, err := s.pool.Query(ctx, publishedSelect+` AND EXISTS (
		SELECT 1 FROM data_resource_grants g
		WHERE g.user_id=$1 AND g.resource_type=$2 AND g.resource_id=s.space_id AND g.action=$3
	) ORDER BY s.updated_at DESC`, userID, ResourceTypeSpace, SpaceActionRead)
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

func (s *PostgresStore) GetPublished(ctx context.Context, skillID string) (PublishedDetail, error) {
	var detail PublishedDetail
	if err := scanPublished(s.pool.QueryRow(ctx, publishedSelect+` AND s.skill_id=$1`, skillID), &detail); err != nil {
		return PublishedDetail{}, mapNotFound(err)
	}
	return detail, nil
}

func (s *PostgresStore) SetCurrentVersion(ctx context.Context, skillID, versionID string, now time.Time) (Skill, Version, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Skill{}, Version{}, err
	}
	defer tx.Rollback(ctx)
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
	if skill.CurrentVersionID == nil || *skill.CurrentVersionID != versionID {
		if _, err := tx.Exec(ctx, `UPDATE skills SET current_version_id=$2,updated_at=$3 WHERE skill_id=$1`, skillID, versionID, now); err != nil {
			return Skill{}, Version{}, mapStoreError(err)
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
	tag, err := tx.Exec(ctx, `UPDATE skills SET space_id=$2,updated_at=$3 WHERE skill_id=ANY($1) AND space_id<>$2`, skillIDs, targetSpaceID, now)
	if err != nil {
		return SkillSpaceMoveResult{}, mapStoreError(err)
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
	var current pgtype.Text
	if err := tx.QueryRow(ctx, `SELECT current_version_id FROM skills WHERE skill_id=$1 FOR UPDATE`, skillID).Scan(&current); err != nil {
		return nil, mapNotFound(err)
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
		cleared = &version
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return cleared, nil
}

const adminSkillSelect = `
SELECT s.skill_id,s.space_id,sp.name,s.name,COALESCE(cv.description,lv.description,''),s.current_version_id,s.created_by,s.created_at,s.updated_at
FROM skills s
JOIN skill_spaces sp ON sp.space_id=s.space_id
LEFT JOIN skill_versions cv ON cv.skill_id=s.skill_id AND cv.version_id=s.current_version_id
LEFT JOIN LATERAL (
  SELECT description FROM skill_versions WHERE skill_id=s.skill_id ORDER BY created_at DESC LIMIT 1
) lv ON TRUE`

const publishedSelect = `
SELECT s.skill_id,s.space_id,sp.name,s.name,v.description,v.version_id,v.version,v.package_sha256,s.updated_at,v.changelog,v.package_path
FROM skills s
JOIN skill_spaces sp ON sp.space_id=s.space_id
JOIN skill_versions v ON v.skill_id=s.skill_id AND v.version_id=s.current_version_id
WHERE s.current_version_id IS NOT NULL`

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
	if err := row.Scan(&skill.SkillID, &skill.SpaceID, &skill.SpaceName, &skill.Name, &skill.Description, &current, &skill.CreatedBy, &skill.CreatedAt, &skill.UpdatedAt); err != nil {
		return err
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
	if err := row.Scan(
		&version.VersionID, &version.SkillID, &version.Version, &version.Description, &version.Changelog, &version.PackagePath, &version.PackageSHA256, &version.CreatedAt,
		&sourceID, &repositoryOwner, &repositoryName, &sourcePath, &sourceCommitSHA, &sourceContentSHA256, &uploadedByUserID, &uploadedByAgentID,
	); err != nil {
		return err
	}
	if uploadedByUserID.Valid {
		version.UploadedByUserID = uploadedByUserID.String
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
