package sharedfiles

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

func (s *PostgresStore) CreateSpace(ctx context.Context, space Space) (SpaceSummary, error) {
	_, err := s.pool.Exec(ctx, `INSERT INTO shared_spaces
(space_id,name,description,created_by,updated_by,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7)`, space.SpaceID, space.Name, space.Description, space.CreatedBy, space.UpdatedBy, space.CreatedAt, space.UpdatedAt)
	if err != nil {
		return SpaceSummary{}, mapPostgresError(err, ErrSpaceNameConflict)
	}
	return SpaceSummary{Space: space}, nil
}

func (s *PostgresStore) UpdateSpace(ctx context.Context, space Space) (SpaceSummary, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE shared_spaces SET name=$2,description=$3,updated_by=$4,updated_at=$5 WHERE space_id=$1`,
		space.SpaceID, space.Name, space.Description, space.UpdatedBy, space.UpdatedAt)
	if err != nil {
		return SpaceSummary{}, mapPostgresError(err, ErrSpaceNameConflict)
	}
	if tag.RowsAffected() == 0 {
		return SpaceSummary{}, ErrSharedSpaceNotFound
	}
	return s.GetSpaceSummary(ctx, space.SpaceID)
}

func (s *PostgresStore) GetSpaceSummary(ctx context.Context, spaceID string) (SpaceSummary, error) {
	var item SpaceSummary
	err := s.pool.QueryRow(ctx, spaceSummarySQL+` WHERE s.space_id=$1 GROUP BY s.space_id`, spaceID).Scan(spaceSummaryDest(&item)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return SpaceSummary{}, ErrSharedSpaceNotFound
	}
	return item, err
}

func (s *PostgresStore) ListSpaceSummaries(ctx context.Context, filter SpaceFilter) ([]SpaceSummary, error) {
	rows, err := s.pool.Query(ctx, spaceSummarySQL+`
WHERE ($1='' OR strpos(lower(s.name),lower($1))>0)
  AND ($2::timestamptz IS NULL OR s.updated_at<$2 OR (s.updated_at=$2 AND s.space_id>$3))
GROUP BY s.space_id
ORDER BY s.updated_at DESC,s.space_id ASC LIMIT $4`, filter.Query, nullableTime(filter.Cursor.UpdatedAt), filter.Cursor.ID, filter.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []SpaceSummary{}
	for rows.Next() {
		var item SpaceSummary
		if err := rows.Scan(spaceSummaryDest(&item)...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) ListAuthorizedSpaces(ctx context.Context, filter SpaceFilter) ([]Space, error) {
	rows, err := s.pool.Query(ctx, `SELECT s.space_id,s.name,s.description,s.updated_at
FROM shared_spaces s
JOIN data_resource_grants g ON g.resource_type=$1 AND g.resource_id=s.space_id AND g.action=$2 AND g.user_id=$3
WHERE ($4::timestamptz IS NULL OR s.updated_at<$4 OR (s.updated_at=$4 AND s.space_id>$5))
ORDER BY s.updated_at DESC,s.space_id ASC LIMIT $6`, ResourceTypeSharedSpace, ActionRead, filter.UserID,
		nullableTime(filter.Cursor.UpdatedAt), filter.Cursor.ID, filter.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Space{}
	for rows.Next() {
		var item Space
		if err := rows.Scan(&item.SpaceID, &item.Name, &item.Description, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) ListMembers(ctx context.Context, filter MemberFilter) ([]Member, error) {
	rows, err := s.pool.Query(ctx, `SELECT a.user_id,COALESCE(NULLIF(a.name,''),a.email,a.user_id),a.email,a.status,
CASE WHEN count(DISTINCT g.action) FILTER (WHERE g.action IN ($2,$3))=2 THEN 'complete' ELSE 'incomplete' END,
bool_or(g.action=$2),bool_or(g.action=$3),min(g.created_at),max(g.updated_at)
FROM data_resource_grants g JOIN accounts a ON a.user_id=g.user_id
WHERE g.resource_type=$1 AND g.resource_id=$4 AND g.action IN ($2,$3)
  AND ($5='' OR strpos(lower(a.user_id),lower($5))>0 OR strpos(lower(a.name),lower($5))>0 OR strpos(lower(a.email),lower($5))>0)
  AND ($6='' OR COALESCE(NULLIF(a.name,''),a.email,a.user_id)>$6 OR (COALESCE(NULLIF(a.name,''),a.email,a.user_id)=$6 AND a.user_id>$7))
GROUP BY a.user_id
ORDER BY COALESCE(NULLIF(a.name,''),a.email,a.user_id),a.user_id LIMIT $8`, ResourceTypeSharedSpace, ActionRead, ActionWrite,
		filter.SpaceID, filter.Query, filter.Cursor.Name, filter.Cursor.ID, filter.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Member{}
	for rows.Next() {
		var item Member
		var read, write bool
		if err := rows.Scan(&item.UserID, &item.Name, &item.Email, &item.AccountStatus, &item.GrantStatus, &read, &write, &item.JoinedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		if read {
			item.Actions = append(item.Actions, ActionRead)
		}
		if write {
			item.Actions = append(item.Actions, ActionWrite)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) ListMemberCandidates(ctx context.Context, filter MemberFilter) ([]MemberCandidate, error) {
	rows, err := s.pool.Query(ctx, `SELECT a.user_id,COALESCE(NULLIF(a.name,''),a.email,a.user_id),a.email
FROM accounts a
WHERE a.status='active'
  AND NOT EXISTS (SELECT 1 FROM data_resource_grants g WHERE g.user_id=a.user_id AND g.resource_type=$1 AND g.resource_id=$2 AND g.action IN ($3,$4))
  AND ($5='' OR strpos(lower(a.user_id),lower($5))>0 OR strpos(lower(a.name),lower($5))>0 OR strpos(lower(a.email),lower($5))>0)
  AND ($6='' OR COALESCE(NULLIF(a.name,''),a.email,a.user_id)>$6 OR (COALESCE(NULLIF(a.name,''),a.email,a.user_id)=$6 AND a.user_id>$7))
ORDER BY COALESCE(NULLIF(a.name,''),a.email,a.user_id),a.user_id LIMIT $8`, ResourceTypeSharedSpace, filter.SpaceID,
		ActionRead, ActionWrite, filter.Query, filter.Cursor.Name, filter.Cursor.ID, filter.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []MemberCandidate{}
	for rows.Next() {
		var item MemberCandidate
		if err := rows.Scan(&item.UserID, &item.Name, &item.Email); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) AddMember(ctx context.Context, spaceID, userID string, actions []string, createdBy string) (Member, error) {
	return s.setMember(ctx, spaceID, userID, actions, createdBy, false)
}

func (s *PostgresStore) UpdateMember(ctx context.Context, spaceID, userID string, actions []string, createdBy string) (Member, error) {
	return s.setMember(ctx, spaceID, userID, actions, createdBy, true)
}

func (s *PostgresStore) setMember(ctx context.Context, spaceID, userID string, actions []string, createdBy string, replace bool) (Member, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Member{}, err
	}
	defer tx.Rollback(ctx)
	var member Member
	if err := tx.QueryRow(ctx, `SELECT user_id,COALESCE(NULLIF(name,''),email,user_id),email,status FROM accounts WHERE user_id=$1 FOR SHARE`, userID).
		Scan(&member.UserID, &member.Name, &member.Email, &member.AccountStatus); err != nil || member.AccountStatus != "active" {
		return Member{}, ErrMemberNotFound
	}
	var spaceExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM shared_spaces WHERE space_id=$1)`, spaceID).Scan(&spaceExists); err != nil {
		return Member{}, err
	}
	if !spaceExists {
		return Member{}, ErrSharedSpaceNotFound
	}
	rows, err := tx.Query(ctx, `SELECT created_at FROM data_resource_grants
WHERE user_id=$1 AND resource_type=$2 AND resource_id=$3 AND action IN ($4,$5) FOR UPDATE`,
		userID, ResourceTypeSharedSpace, spaceID, ActionRead, ActionWrite)
	if err != nil {
		return Member{}, err
	}
	var existingCount int
	var joinedAt time.Time
	for rows.Next() {
		var createdAt time.Time
		if err := rows.Scan(&createdAt); err != nil {
			rows.Close()
			return Member{}, err
		}
		if joinedAt.IsZero() || createdAt.Before(joinedAt) {
			joinedAt = createdAt
		}
		existingCount++
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Member{}, err
	}
	rows.Close()
	if !replace && existingCount > 0 {
		return Member{}, ErrMemberAlreadyExists
	}
	if replace {
		if existingCount == 0 {
			return Member{}, ErrMemberNotFound
		}
		if _, err := tx.Exec(ctx, `DELETE FROM data_resource_grants WHERE user_id=$1 AND resource_type=$2 AND resource_id=$3 AND action IN ($4,$5)`,
			userID, ResourceTypeSharedSpace, spaceID, ActionRead, ActionWrite); err != nil {
			return Member{}, err
		}
	}
	member.UpdatedAt = time.Now().UTC()
	if joinedAt.IsZero() {
		joinedAt = member.UpdatedAt
	}
	member.JoinedAt = joinedAt
	for _, action := range actions {
		if _, err := tx.Exec(ctx, `INSERT INTO data_resource_grants (grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at)
	VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, newID("drg_"), userID, ResourceTypeSharedSpace, spaceID, action, createdBy, member.UpdatedAt); err != nil {
			return Member{}, mapPostgresError(err, ErrMemberAlreadyExists)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Member{}, err
	}
	member.Actions = actions
	member.GrantStatus = "incomplete"
	if containsAction(actions, ActionWrite) {
		member.GrantStatus = "complete"
	}
	return member, nil
}

func (s *PostgresStore) RemoveMember(ctx context.Context, spaceID, userID string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM data_resource_grants WHERE user_id=$1 AND resource_type=$2 AND resource_id=$3 AND action IN ($4,$5)`,
		userID, ResourceTypeSharedSpace, spaceID, ActionRead, ActionWrite)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrMemberNotFound
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) ListFiles(ctx context.Context, filter FileFilter) ([]File, error) {
	rows, err := s.pool.Query(ctx, `SELECT f.file_id,f.space_id,s.name,f.logical_path,f.file_name,f.size_bytes,f.sha256,f.content_type,f.revision,
f.updated_by_user_id,COALESCE(f.updated_by_agent_id,''),f.updated_at
FROM shared_files f JOIN shared_spaces s ON s.space_id=f.space_id
JOIN data_resource_grants g ON g.resource_type=$1 AND g.resource_id=f.space_id AND g.action=$2 AND g.user_id=$3
WHERE ($4='' OR f.space_id=$4)
  AND ($5='' OR strpos(lower(f.file_id),lower($5))>0 OR strpos(lower(f.file_name),lower($5))>0)
  AND ($6='' OR left(f.logical_path,length($6))=$6)
  AND ($7::timestamptz IS NULL OR f.updated_at<$7 OR (f.updated_at=$7 AND f.file_id>$8))
ORDER BY f.updated_at DESC,f.file_id ASC LIMIT $9`, ResourceTypeSharedSpace, ActionRead, filter.UserID, filter.SpaceID,
		filter.Query, filter.LogicalPathPrefix, nullableTime(filter.Cursor.UpdatedAt), filter.Cursor.ID, filter.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []File{}
	for rows.Next() {
		var item File
		if err := rows.Scan(&item.FileID, &item.SpaceID, &item.SpaceName, &item.LogicalPath, &item.FileName, &item.SizeBytes,
			&item.SHA256, &item.ContentType, &item.Revision, &item.UpdatedByUserID, &item.UpdatedByAgentID, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) ListAdminFiles(ctx context.Context, filter FileFilter) ([]File, error) {
	rows, err := s.pool.Query(ctx, `SELECT f.file_id,f.space_id,s.name,f.logical_path,f.file_name,f.size_bytes,f.sha256,f.content_type,f.revision,
f.updated_by_user_id,COALESCE(f.updated_by_agent_id,''),f.updated_at
FROM shared_files f JOIN shared_spaces s ON s.space_id=f.space_id
WHERE ($1='' OR f.space_id=$1)
  AND ($2='' OR strpos(lower(f.file_id),lower($2))>0 OR strpos(lower(f.file_name),lower($2))>0)
  AND ($3='' OR left(f.logical_path,length($3))=$3)
  AND ($4::timestamptz IS NULL OR f.updated_at<$4 OR (f.updated_at=$4 AND f.file_id>$5))
ORDER BY f.updated_at DESC,f.file_id ASC LIMIT $6`, filter.SpaceID, filter.Query, filter.LogicalPathPrefix,
		nullableTime(filter.Cursor.UpdatedAt), filter.Cursor.ID, filter.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []File{}
	for rows.Next() {
		var item File
		if err := rows.Scan(&item.FileID, &item.SpaceID, &item.SpaceName, &item.LogicalPath, &item.FileName, &item.SizeBytes,
			&item.SHA256, &item.ContentType, &item.Revision, &item.UpdatedByUserID, &item.UpdatedByAgentID, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) CheckSpaceAccess(ctx context.Context, userID, spaceID, action string) error {
	var ignored string
	err := s.pool.QueryRow(ctx, `SELECT s.space_id FROM shared_spaces s
JOIN data_resource_grants g ON g.resource_type=$1 AND g.resource_id=s.space_id AND g.action=$2 AND g.user_id=$3
WHERE s.space_id=$4`, ResourceTypeSharedSpace, action, userID, spaceID).Scan(&ignored)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSharedSpaceNotFound
	}
	return err
}

func (s *PostgresStore) GetAuthorizedFile(ctx context.Context, userID, fileID, action string) (File, error) {
	var item File
	err := s.pool.QueryRow(ctx, `SELECT f.file_id,f.space_id,s.name,f.logical_path,f.file_name,f.storage_key,f.size_bytes,f.sha256,f.content_type,f.revision,
f.created_by_user_id,COALESCE(f.created_by_agent_id,''),f.updated_by_user_id,COALESCE(f.updated_by_agent_id,''),f.created_at,f.updated_at
FROM shared_files f JOIN shared_spaces s ON s.space_id=f.space_id
JOIN data_resource_grants g ON g.resource_type=$1 AND g.resource_id=f.space_id AND g.action=$2 AND g.user_id=$3
WHERE f.file_id=$4`, ResourceTypeSharedSpace, action, userID, fileID).Scan(fileDest(&item)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, ErrSharedFileNotFound
	}
	return item, err
}

func (s *PostgresStore) GetAuthorizedFileByPath(ctx context.Context, userID, spaceID, logicalPath, action string) (File, error) {
	var item File
	err := s.pool.QueryRow(ctx, `SELECT f.file_id,f.space_id,s.name,f.logical_path,f.file_name,f.storage_key,f.size_bytes,f.sha256,f.content_type,f.revision,
f.created_by_user_id,COALESCE(f.created_by_agent_id,''),f.updated_by_user_id,COALESCE(f.updated_by_agent_id,''),f.created_at,f.updated_at
FROM shared_files f JOIN shared_spaces s ON s.space_id=f.space_id
JOIN data_resource_grants g ON g.resource_type=$1 AND g.resource_id=f.space_id AND g.action=$2 AND g.user_id=$3
WHERE f.space_id=$4 AND f.logical_path=$5`, ResourceTypeSharedSpace, action, userID, spaceID, logicalPath).Scan(fileDest(&item)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, ErrSharedFileNotFound
	}
	return item, err
}

func (s *PostgresStore) GetAdminFile(ctx context.Context, fileID string) (File, error) {
	var item File
	err := s.pool.QueryRow(ctx, `SELECT f.file_id,f.space_id,s.name,f.logical_path,f.file_name,f.storage_key,f.size_bytes,f.sha256,f.content_type,f.revision,
f.created_by_user_id,COALESCE(f.created_by_agent_id,''),f.updated_by_user_id,COALESCE(f.updated_by_agent_id,''),f.created_at,f.updated_at
FROM shared_files f JOIN shared_spaces s ON s.space_id=f.space_id
WHERE f.file_id=$1`, fileID).Scan(fileDest(&item)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, ErrSharedFileNotFound
	}
	return item, err
}

func (s *PostgresStore) GetAdminFileByPath(ctx context.Context, spaceID, logicalPath string) (File, error) {
	var item File
	err := s.pool.QueryRow(ctx, `SELECT f.file_id,f.space_id,s.name,f.logical_path,f.file_name,f.storage_key,f.size_bytes,f.sha256,f.content_type,f.revision,
f.created_by_user_id,COALESCE(f.created_by_agent_id,''),f.updated_by_user_id,COALESCE(f.updated_by_agent_id,''),f.created_at,f.updated_at
FROM shared_files f JOIN shared_spaces s ON s.space_id=f.space_id
WHERE f.space_id=$1 AND f.logical_path=$2`, spaceID, logicalPath).Scan(fileDest(&item)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, ErrSharedFileNotFound
	}
	return item, err
}

func (s *PostgresStore) CreateFileAuthorized(ctx context.Context, userID string, file File) (File, error) {
	return s.createFile(ctx, userID, file)
}

func (s *PostgresStore) CreateAdminFile(ctx context.Context, file File) (File, error) {
	return s.createFile(ctx, "", file)
}

func (s *PostgresStore) createFile(ctx context.Context, authorizedUserID string, file File) (File, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback(ctx)
	if authorizedUserID == "" {
		if err := lockSharedSpace(ctx, tx, file.SpaceID); err != nil {
			return File{}, err
		}
	} else if err := lockWriteGrant(ctx, tx, authorizedUserID, file.SpaceID); err != nil {
		return File{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO shared_files
(file_id,space_id,logical_path,file_name,storage_key,size_bytes,sha256,content_type,revision,created_by_user_id,created_by_agent_id,updated_by_user_id,updated_by_agent_id,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$9,$10,$11,$11)`, file.FileID, file.SpaceID, file.LogicalPath, file.FileName,
		file.StorageKey, file.SizeBytes, file.SHA256, file.ContentType, file.CreatedByUserID, nullableString(file.CreatedByAgentID), file.CreatedAt)
	if err != nil {
		return File{}, mapPostgresError(err, ErrFileAlreadyExists)
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	file.Revision = 1
	file.UpdatedByUserID, file.UpdatedByAgentID = file.CreatedByUserID, file.CreatedByAgentID
	file.UpdatedAt = file.CreatedAt
	return file, nil
}

func (s *PostgresStore) ReplaceFileAuthorized(ctx context.Context, userID string, file File, expectedRevision int64) (File, string, error) {
	return s.replaceFile(ctx, userID, file, expectedRevision)
}

func (s *PostgresStore) ReplaceAdminFile(ctx context.Context, file File, expectedRevision int64) (File, string, error) {
	return s.replaceFile(ctx, "", file, expectedRevision)
}

func (s *PostgresStore) replaceFile(ctx context.Context, authorizedUserID string, file File, expectedRevision int64) (File, string, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return File{}, "", err
	}
	defer tx.Rollback(ctx)
	if authorizedUserID == "" {
		if err := lockSharedSpace(ctx, tx, file.SpaceID); err != nil {
			return File{}, "", err
		}
	} else if err := lockWriteGrant(ctx, tx, authorizedUserID, file.SpaceID); err != nil {
		return File{}, "", err
	}
	var current File
	err = tx.QueryRow(ctx, `SELECT file_id,storage_key,revision,created_by_user_id,COALESCE(created_by_agent_id,''),created_at
FROM shared_files WHERE space_id=$1 AND logical_path=$2 FOR UPDATE`, file.SpaceID, file.LogicalPath).
		Scan(&current.FileID, &current.StorageKey, &current.Revision, &current.CreatedByUserID, &current.CreatedByAgentID, &current.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, "", ErrSharedFileNotFound
	}
	if err != nil {
		return File{}, "", err
	}
	if current.Revision != expectedRevision {
		return File{}, "", &RevisionConflictError{CurrentRevision: current.Revision}
	}
	tag, err := tx.Exec(ctx, `UPDATE shared_files SET storage_key=$3,size_bytes=$4,sha256=$5,content_type=$6,
revision=revision+1,updated_by_user_id=$7,updated_by_agent_id=$8,updated_at=$9
WHERE space_id=$1 AND logical_path=$2 AND revision=$10`, file.SpaceID, file.LogicalPath, file.StorageKey, file.SizeBytes,
		file.SHA256, file.ContentType, file.UpdatedByUserID, nullableString(file.UpdatedByAgentID), file.UpdatedAt, expectedRevision)
	if err != nil {
		return File{}, "", err
	}
	if tag.RowsAffected() == 0 {
		return File{}, "", &RevisionConflictError{CurrentRevision: current.Revision}
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, "", err
	}
	file.FileID = current.FileID
	file.Revision = expectedRevision + 1
	file.CreatedByUserID, file.CreatedByAgentID, file.CreatedAt = current.CreatedByUserID, current.CreatedByAgentID, current.CreatedAt
	return file, current.StorageKey, nil
}

type RevisionConflictError struct{ CurrentRevision int64 }

func (e *RevisionConflictError) Error() string { return ErrRevisionConflict.Error() }
func (e *RevisionConflictError) Unwrap() error { return ErrRevisionConflict }

func lockWriteGrant(ctx context.Context, tx pgx.Tx, userID, spaceID string) error {
	var ignored string
	err := tx.QueryRow(ctx, `SELECT g.grant_id FROM data_resource_grants g JOIN shared_spaces s ON s.space_id=g.resource_id
WHERE g.user_id=$1 AND g.resource_type=$2 AND g.resource_id=$3 AND g.action=$4 FOR SHARE OF g,s`,
		userID, ResourceTypeSharedSpace, spaceID, ActionWrite).Scan(&ignored)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSharedSpaceNotFound
	}
	return err
}

func lockSharedSpace(ctx context.Context, tx pgx.Tx, spaceID string) error {
	var ignored string
	err := tx.QueryRow(ctx, `SELECT space_id FROM shared_spaces WHERE space_id=$1 FOR SHARE`, spaceID).Scan(&ignored)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSharedSpaceNotFound
	}
	return err
}

const spaceSummarySQL = `SELECT s.space_id,s.name,s.description,s.created_by,s.updated_by,s.created_at,s.updated_at,
(SELECT count(DISTINCT g.user_id) FROM data_resource_grants g WHERE g.resource_type='shared_space' AND g.resource_id=s.space_id AND g.action='read'),
(SELECT count(*) FROM shared_files f WHERE f.space_id=s.space_id),
(SELECT COALESCE(sum(f.size_bytes),0) FROM shared_files f WHERE f.space_id=s.space_id)
FROM shared_spaces s`

func spaceSummaryDest(item *SpaceSummary) []any {
	return []any{&item.SpaceID, &item.Name, &item.Description, &item.CreatedBy, &item.UpdatedBy, &item.CreatedAt, &item.UpdatedAt,
		&item.MemberCount, &item.FileCount, &item.SizeBytes}
}

func fileDest(item *File) []any {
	return []any{&item.FileID, &item.SpaceID, &item.SpaceName, &item.LogicalPath, &item.FileName, &item.StorageKey, &item.SizeBytes,
		&item.SHA256, &item.ContentType, &item.Revision, &item.CreatedByUserID, &item.CreatedByAgentID,
		&item.UpdatedByUserID, &item.UpdatedByAgentID, &item.CreatedAt, &item.UpdatedAt}
}

func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func mapPostgresError(err error, conflict error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return conflict
	}
	return err
}
