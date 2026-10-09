package skillhub

import (
	"context"
	"time"
)

const personalApprovalProcessSQL = `r.status='pending' AND a.status='pending' AND r.scope_id=s.space_id AND r.content_digest=v.package_sha256
AND EXISTS (SELECT 1 FROM skill_spaces sp WHERE sp.space_id=s.space_id AND sp.approval_provider='local'
AND (EXISTS (SELECT 1 FROM approval_config_approvers c WHERE c.scope_type='skill_space' AND c.scope_id=sp.space_id)
OR EXISTS (SELECT 1 FROM approval_config_roles c WHERE c.scope_type='skill_space' AND c.scope_id=sp.space_id)))`

const personalApprovalSelect = `SELECT r.id,s.skill_id,v.version_id,v.version,s.name,r.scope_id,r.content_digest,r.status,
COALESCE(a.status,''),COALESCE(v.uploaded_by_user_id,''),r.created_at,a.decided_at,COALESCE((` + personalApprovalProcessSQL + `),false)
FROM approval_requests r JOIN skill_versions v ON v.version_id=r.business_id JOIN skills s ON s.skill_id=v.skill_id
LEFT JOIN approval_request_approvers a ON a.request_id=r.id AND a.user_id=$1
WHERE r.business_type='skill_version' AND r.action='publish' AND r.scope_type='skill_space'
AND EXISTS (SELECT 1 FROM accounts u WHERE u.user_id=$1 AND u.status='active')
AND (a.user_id=$1 OR v.uploaded_by_user_id=$1)
AND EXISTS (SELECT 1 FROM effective_data_resource_permissions g WHERE g.user_id=$1 AND g.resource_type='skill_space' AND g.resource_id=r.scope_id AND g.action='read')
AND EXISTS (SELECT 1 FROM effective_data_resource_permissions g WHERE g.user_id=$1 AND g.resource_type='skill_space' AND g.resource_id=s.space_id AND g.action='read')`

func scanPersonalApproval(row rowScanner, item *PersonalApproval) error {
	err := row.Scan(&item.RequestID, &item.SkillID, &item.VersionID, &item.Version, &item.Title, &item.SpaceID, &item.ContentDigest, &item.Status, &item.MyStatus, &item.InitiatedBy, &item.CreatedAt, &item.ActedAt, &item.CanProcess)
	item.CreatedAt = item.CreatedAt.UTC()
	return err
}

func (s *PostgresStore) ListPersonalApprovals(ctx context.Context, user string, query PersonalApprovalQuery) ([]PersonalApproval, error) {
	at := query.BeforeTime
	if at.IsZero() {
		at = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	rows, err := s.pool.Query(ctx, personalApprovalSelect+`
AND ($2='all' OR $2='' OR r.status=$2)
AND (($3='todo' AND (`+personalApprovalProcessSQL+`)) OR ($3='done' AND a.status IN ('approved','rejected')) OR ($3='initiated' AND v.uploaded_by_user_id=$1))
AND (r.created_at,'skill'::text COLLATE "C",r.id COLLATE "C")<($4,$5::text COLLATE "C",$6::text COLLATE "C")
ORDER BY r.created_at DESC,r.id COLLATE "C" DESC LIMIT $7`, user, query.Status, query.View, at, query.BeforeKind, query.BeforeID, query.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []PersonalApproval{}
	for rows.Next() {
		var item PersonalApproval
		if err := scanPersonalApproval(rows, &item); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) GetPersonalApproval(ctx context.Context, user, id string) (PersonalApproval, AdminDetail, error) {
	var item PersonalApproval
	if err := scanPersonalApproval(s.pool.QueryRow(ctx, personalApprovalSelect+` AND r.id=$2`, user, id), &item); err != nil {
		return item, AdminDetail{}, mapNotFound(err)
	}
	var skill Skill
	if err := scanSkill(s.pool.QueryRow(ctx, `SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=$1`, item.SkillID), &skill); err != nil {
		return item, AdminDetail{}, mapNotFound(err)
	}
	var version Version
	if err := scanVersionSource(s.pool.QueryRow(ctx, `SELECT v.version_id,v.skill_id,v.version,v.description,v.changelog,v.package_path,v.package_sha256,v.created_at,
v.source_id,src.repository_owner,src.repository_name,v.source_path,v.source_commit_sha,v.source_content_sha256,
v.uploaded_by_user_id,v.uploaded_by_agent_id,v.skill_name,v.approval_status,COALESCE(v.approved_space_id,''),COALESCE(v.reviewed_by,''),v.reviewed_at,v.review_comment
FROM skill_versions v LEFT JOIN skill_sources src ON src.source_id=v.source_id WHERE v.version_id=$1 AND v.skill_id=$2`, item.VersionID, item.SkillID), &version); err != nil {
		return item, AdminDetail{}, mapNotFound(err)
	}
	var standard string
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(scoring_standard_version,'') FROM approval_requests WHERE id=$1`, id).Scan(&standard); err != nil {
		return item, AdminDetail{}, mapNotFound(err)
	}
	progress, err := readLocalRequestProgress(ctx, s.pool, id, item.Status, standard, item.ContentDigest)
	if err != nil {
		return item, AdminDetail{}, err
	}
	version.LocalApproval = progress
	if err := s.pool.QueryRow(ctx, `SELECT name FROM skill_spaces WHERE space_id=$1`, skill.SpaceID).Scan(&skill.SpaceName); err != nil {
		return item, AdminDetail{}, err
	}
	return item, AdminDetail{Skill: skill, Versions: []Version{version}}, nil
}

func (s *PostgresStore) CheckApprovalVersionBinding(ctx context.Context, user, skillID, versionID string) error {
	var valid bool
	err := s.pool.QueryRow(ctx, `SELECT
(NOT EXISTS (SELECT 1 FROM approval_requests r WHERE r.business_type='skill_version' AND r.action='publish' AND r.scope_type='skill_space' AND r.business_id=v.version_id)
AND NOT EXISTS (SELECT 1 FROM skill_version_approval_instances ai WHERE ai.version_id=v.version_id))
OR EXISTS (SELECT 1 FROM approval_requests r WHERE r.business_type='skill_version' AND r.action='publish' AND r.scope_type='skill_space' AND r.business_id=v.version_id AND r.scope_id=s.space_id AND r.content_digest=v.package_sha256 AND r.status<>'invalidated')
OR EXISTS (SELECT 1 FROM skill_version_approval_instances ai WHERE ai.version_id=v.version_id AND ai.status<>'invalidated' AND ai.space_id=s.space_id AND ai.package_sha256=v.package_sha256 AND ai.id=(SELECT id FROM skill_version_approval_instances WHERE version_id=v.version_id ORDER BY created_at DESC,id DESC LIMIT 1))
FROM skill_versions v JOIN skills s ON s.skill_id=v.skill_id
WHERE s.skill_id=$2 AND v.version_id=$3
AND EXISTS (SELECT 1 FROM effective_data_resource_permissions g WHERE g.user_id=$1 AND g.resource_type='skill_space' AND g.resource_id=s.space_id AND g.action='read')`, user, skillID, versionID).Scan(&valid)
	if err != nil {
		return mapNotFound(err)
	}
	if !valid {
		return ErrConflict
	}
	return nil
}
