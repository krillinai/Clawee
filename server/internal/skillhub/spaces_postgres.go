package skillhub

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const spaceSummarySelect = `SELECT sp.space_id,sp.name,sp.description,sp.created_by,sp.updated_by,sp.created_at,sp.updated_at,
(SELECT count(DISTINCT g.user_id) FROM data_resource_grants g WHERE g.resource_type='skill_space' AND g.resource_id=sp.space_id AND g.action='read'),
(SELECT count(*) FROM skills s WHERE s.space_id=sp.space_id),
(SELECT count(*) FROM skills s WHERE s.space_id=sp.space_id AND s.current_version_id IS NOT NULL)
FROM skill_spaces sp`

func (s *PostgresStore) CreateSpace(ctx context.Context, space Space) (SpaceSummary, error) {
	_, err := s.pool.Exec(ctx, `INSERT INTO skill_spaces (space_id,name,description,created_by,updated_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		space.SpaceID, space.Name, space.Description, space.CreatedBy, space.UpdatedBy, space.CreatedAt, space.UpdatedAt)
	if err != nil {
		return SpaceSummary{}, mapSpaceStoreError(err)
	}
	return s.GetSpace(ctx, space.SpaceID)
}

func (s *PostgresStore) UpdateSpace(ctx context.Context, space Space) (SpaceSummary, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE skill_spaces SET name=$2,description=$3,updated_by=$4,updated_at=$5 WHERE space_id=$1`,
		space.SpaceID, space.Name, space.Description, space.UpdatedBy, space.UpdatedAt)
	if err != nil {
		return SpaceSummary{}, mapSpaceStoreError(err)
	}
	if tag.RowsAffected() == 0 {
		return SpaceSummary{}, ErrSpaceNotFound
	}
	return s.GetSpace(ctx, space.SpaceID)
}

func (s *PostgresStore) ListSpaces(ctx context.Context) ([]SpaceSummary, error) {
	rows, err := s.pool.Query(ctx, spaceSummarySelect+` ORDER BY sp.updated_at DESC,sp.space_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []SpaceSummary{}
	for rows.Next() {
		var item SpaceSummary
		if err := scanSpaceSummary(rows, &item); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) GetSpace(ctx context.Context, spaceID string) (SpaceSummary, error) {
	var item SpaceSummary
	if err := scanSpaceSummary(s.pool.QueryRow(ctx, spaceSummarySelect+` WHERE sp.space_id=$1`, spaceID), &item); err != nil {
		return SpaceSummary{}, mapSpaceNotFound(err)
	}
	return item, nil
}

func (s *PostgresStore) ListAuthorizedSpaces(ctx context.Context, userID string) ([]Space, error) {
	rows, err := s.pool.Query(ctx, `SELECT sp.space_id,sp.name,sp.description,sp.updated_at,
	bool_or(g.action='read'),bool_or(g.action='write')
FROM skill_spaces sp JOIN data_resource_grants g ON g.resource_type='skill_space' AND g.resource_id=sp.space_id AND g.user_id=$1
GROUP BY sp.space_id ORDER BY sp.updated_at DESC,sp.space_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Space{}
	for rows.Next() {
		var item Space
		var read, write bool
		if err := rows.Scan(&item.SpaceID, &item.Name, &item.Description, &item.UpdatedAt, &read, &write); err != nil {
			return nil, err
		}
		if !read {
			continue
		}
		item.Actions = []string{SpaceActionRead}
		if write {
			item.Actions = append(item.Actions, SpaceActionWrite)
		}
		item.UpdatedAt = item.UpdatedAt.UTC()
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) CheckSpaceAccess(ctx context.Context, userID, spaceID, action string) error {
	var found string
	err := s.pool.QueryRow(ctx, `SELECT sp.space_id FROM skill_spaces sp JOIN data_resource_grants g
ON g.resource_type='skill_space' AND g.resource_id=sp.space_id AND g.user_id=$1 AND g.action=$2
WHERE sp.space_id=$3`, userID, action, spaceID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSpaceNotFound
	}
	return err
}

func (s *PostgresStore) CheckSkillAccess(ctx context.Context, userID, skillID, action string) error {
	var found string
	err := s.pool.QueryRow(ctx, `SELECT sk.skill_id FROM skills sk JOIN data_resource_grants g
ON g.resource_type='skill_space' AND g.resource_id=sk.space_id AND g.user_id=$1 AND g.action=$2
WHERE sk.skill_id=$3`, userID, action, skillID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func (s *PostgresStore) ListSpaceMembers(ctx context.Context, spaceID string) ([]SpaceMemberGrant, error) {
	if _, err := s.GetSpace(ctx, spaceID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT user_id,bool_or(action='read'),bool_or(action='write'),min(created_at),max(updated_at)
FROM data_resource_grants WHERE resource_type='skill_space' AND resource_id=$1 AND action IN ('read','write')
GROUP BY user_id ORDER BY user_id`, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []SpaceMemberGrant{}
	for rows.Next() {
		var item SpaceMemberGrant
		var read, write bool
		if err := rows.Scan(&item.UserID, &read, &write, &item.JoinedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		actions := map[string]bool{SpaceActionRead: read, SpaceActionWrite: write}
		item.Actions, item.GrantStatus = sortedSpaceActions(actions), grantStatus(actions)
		item.JoinedAt, item.UpdatedAt = item.JoinedAt.UTC(), item.UpdatedAt.UTC()
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) SetSpaceMember(ctx context.Context, spaceID, userID string, actions []string, operator string, replace bool, now time.Time) (SpaceMemberGrant, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SpaceMemberGrant{}, err
	}
	defer tx.Rollback(ctx)
	var active bool
	if err := tx.QueryRow(ctx, `SELECT status='active' FROM accounts WHERE user_id=$1 FOR SHARE`, userID).Scan(&active); err != nil || !active {
		return SpaceMemberGrant{}, ErrMemberNotFound
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM skill_spaces WHERE space_id=$1)`, spaceID).Scan(&exists); err != nil {
		return SpaceMemberGrant{}, err
	}
	if !exists {
		return SpaceMemberGrant{}, ErrSpaceNotFound
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM data_resource_grants WHERE user_id=$1 AND resource_type='skill_space' AND resource_id=$2 AND action IN ('read','write')`, userID, spaceID).Scan(&count); err != nil {
		return SpaceMemberGrant{}, err
	}
	if replace && count == 0 {
		return SpaceMemberGrant{}, ErrMemberNotFound
	}
	if !replace && count > 0 {
		return SpaceMemberGrant{}, ErrMemberAlreadyExists
	}
	if count > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM data_resource_grants WHERE user_id=$1 AND resource_type='skill_space' AND resource_id=$2 AND action IN ('read','write')`, userID, spaceID); err != nil {
			return SpaceMemberGrant{}, err
		}
	}
	for _, action := range actions {
		if _, err := tx.Exec(ctx, `INSERT INTO data_resource_grants (grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at) VALUES ($1,$2,'skill_space',$3,$4,$5,$6,$6)`,
			newID("drg"), userID, spaceID, action, operator, now); err != nil {
			return SpaceMemberGrant{}, mapSpaceStoreError(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return SpaceMemberGrant{}, err
	}
	actionMap := map[string]bool{}
	for _, action := range actions {
		actionMap[action] = true
	}
	return SpaceMemberGrant{UserID: userID, Actions: actions, GrantStatus: grantStatus(actionMap), JoinedAt: now, UpdatedAt: now}, nil
}

func (s *PostgresStore) RemoveSpaceMember(ctx context.Context, spaceID, userID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM data_resource_grants WHERE user_id=$1 AND resource_type='skill_space' AND resource_id=$2 AND action IN ('read','write')`, userID, spaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrMemberNotFound
	}
	return nil
}

func scanSpaceSummary(row rowScanner, item *SpaceSummary) error {
	if err := row.Scan(&item.SpaceID, &item.Name, &item.Description, &item.CreatedBy, &item.UpdatedBy, &item.CreatedAt, &item.UpdatedAt,
		&item.MemberCount, &item.SkillCount, &item.PublishedCount); err != nil {
		return err
	}
	item.CreatedAt, item.UpdatedAt = item.CreatedAt.UTC(), item.UpdatedAt.UTC()
	return nil
}

func mapSpaceNotFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSpaceNotFound
	}
	return err
}

func mapSpaceStoreError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrSpaceNameConflict
	}
	return err
}
