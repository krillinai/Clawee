package skillhub

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func createLocalRequest(ctx context.Context, tx pgx.Tx, versionID, spaceID, digest string, now time.Time) error {
	id := newID("approval")
	_, err := tx.Exec(ctx, `INSERT INTO approval_requests(id,business_type,business_id,action,scope_type,scope_id,content_digest,status,created_at)
SELECT $1,'skill_version',$2,'publish','skill_space',$3,$4,'pending',$5 WHERE EXISTS
(SELECT 1 FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$3)
AND (SELECT approval_provider FROM skill_spaces WHERE space_id=$3)='local'`, id, versionID, spaceID, digest, now)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO approval_request_approvers(request_id,user_id,status)
SELECT $1,user_id,'pending' FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$2
AND EXISTS (SELECT 1 FROM approval_requests WHERE id=$1)`, id, spaceID)
	return err
}

func invalidateLocalRequests(ctx context.Context, tx pgx.Tx, versionIDs []string, now time.Time) error {
	if len(versionIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `UPDATE approval_requests SET status='invalidated',finished_at=$2 WHERE business_type='skill_version' AND action='publish' AND business_id=ANY($1) AND status<>'invalidated'`, versionIDs, now)
	return err
}

func resetStaleLocalRequest(ctx context.Context, tx pgx.Tx, versionID, spaceID, digest string, now time.Time) error {
	var valid bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
SELECT 1 FROM approval_requests r WHERE r.business_type='skill_version' AND r.business_id=$1 AND r.action='publish'
AND r.scope_type='skill_space' AND r.scope_id=$2 AND r.content_digest=$3 AND r.status='approved'
AND NOT EXISTS (SELECT user_id FROM approval_request_approvers WHERE request_id=r.id
                EXCEPT SELECT user_id FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$2)
AND NOT EXISTS (SELECT user_id FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$2
                EXCEPT SELECT user_id FROM approval_request_approvers WHERE request_id=r.id))`, versionID, spaceID, digest).Scan(&valid); err != nil {
		return err
	}
	if valid {
		return nil
	}
	if err := invalidateLocalRequests(ctx, tx, []string{versionID}, now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE skill_versions SET approval_status='pending',approved_space_id=NULL,reviewed_by=NULL,reviewed_at=NULL,review_comment='' WHERE version_id=$1`, versionID); err != nil {
		return err
	}
	return createLocalRequest(ctx, tx, versionID, spaceID, digest, now)
}

func (s *PostgresStore) localProgress(ctx context.Context, versionID, spaceID, digest string) (*LocalApproval, error) {
	return readLocalProgress(ctx, s.pool, versionID, spaceID, digest)
}

func (s *PostgresStore) listLocalProgress(ctx context.Context, items []Skill) (map[string]*LocalApproval, error) {
	type versionScope struct{ spaceID, digest string }
	versions := make(map[string]versionScope, len(items))
	ids := make([]string, 0, len(items))
	for _, item := range items {
		if item.LatestVersion != nil {
			id := item.LatestVersion.VersionID
			ids = append(ids, id)
			versions[id] = versionScope{item.SpaceID, item.LatestVersion.PackageSHA256}
		}
	}
	result := make(map[string]*LocalApproval)
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT r.id,r.business_id,r.scope_id,r.content_digest,r.status,a.user_id,COALESCE(u.name,''),a.status,a.comment,a.decided_at
FROM approval_requests r
JOIN approval_request_approvers a ON a.request_id=r.id JOIN accounts u ON u.user_id=a.user_id
WHERE r.business_type='skill_version' AND r.action='publish' AND r.scope_type='skill_space'
AND r.status<>'invalidated' AND r.business_id=ANY($1)
AND EXISTS (SELECT 1 FROM skill_spaces sp WHERE sp.space_id=r.scope_id AND sp.approval_provider='local'
            AND EXISTS (SELECT 1 FROM approval_config_approvers c WHERE c.scope_type='skill_space' AND c.scope_id=sp.space_id))
ORDER BY r.business_id,r.created_at DESC,r.id DESC,u.name,a.user_id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	selected := make(map[string]string)
	for rows.Next() {
		var requestID, id, spaceID, digest, status string
		var person ApprovalDecision
		if err := rows.Scan(&requestID, &id, &spaceID, &digest, &status, &person.UserID, &person.Name, &person.Status, &person.Comment, &person.DecidedAt); err != nil {
			return nil, err
		}
		if scope, ok := versions[id]; !ok || scope.spaceID != spaceID || scope.digest != digest {
			continue
		}
		if selected[id] != "" && selected[id] != requestID {
			continue
		}
		selected[id] = requestID
		progress := result[id]
		if progress == nil {
			progress = &LocalApproval{Status: status, Approvers: []ApprovalDecision{}}
			result[id] = progress
		}
		progress.Approvers = append(progress.Approvers, person)
		progress.Total++
		if person.Status == "approved" {
			progress.Approved++
		}
	}
	return result, rows.Err()
}

type approvalReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func readLocalProgress(ctx context.Context, reader approvalReader, versionID, spaceID, digest string) (*LocalApproval, error) {
	var id, status string
	err := reader.QueryRow(ctx, `SELECT id,status FROM approval_requests WHERE business_type='skill_version' AND business_id=$1 AND action='publish' AND scope_type='skill_space' AND scope_id=$2 AND content_digest=$3 AND status<>'invalidated'
AND EXISTS (SELECT 1 FROM skill_spaces sp WHERE sp.space_id=$2 AND sp.approval_provider='local'
            AND EXISTS (SELECT 1 FROM approval_config_approvers c WHERE c.scope_type='skill_space' AND c.scope_id=sp.space_id))
ORDER BY created_at DESC,id DESC LIMIT 1`, versionID, spaceID, digest).Scan(&id, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rows, err := reader.Query(ctx, `SELECT a.user_id,COALESCE(u.name,''),a.status,a.comment,a.decided_at FROM approval_request_approvers a JOIN accounts u ON u.user_id=a.user_id WHERE a.request_id=$1 ORDER BY u.name,a.user_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := &LocalApproval{Status: status, Approvers: []ApprovalDecision{}}
	for rows.Next() {
		var item ApprovalDecision
		if err := rows.Scan(&item.UserID, &item.Name, &item.Status, &item.Comment, &item.DecidedAt); err != nil {
			return nil, err
		}
		result.Approvers = append(result.Approvers, item)
		if item.Status == "approved" {
			result.Approved++
		}
	}
	result.Total = len(result.Approvers)
	return result, rows.Err()
}
