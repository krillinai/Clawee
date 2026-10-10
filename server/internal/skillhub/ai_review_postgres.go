package skillhub

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type aiReviewReader interface {
	approvalReader
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func readAIAttempts(ctx context.Context, reader aiReviewReader, request string, now time.Time) ([]AIReviewAttempt, error) {
	_, err := reader.Exec(ctx, `WITH locked AS MATERIALIZED (SELECT id FROM approval_requests WHERE id=$1 FOR UPDATE)
UPDATE skill_ai_review_attempts ai SET status='failed',error=$3,updated_at=$2 FROM locked
WHERE ai.request_id=locked.id AND ai.status='running' AND ai.started_at<=$2::timestamptz-interval '15 minutes'`, request, now, AIReviewTimeout)
	if err != nil {
		return nil, err
	}
	rows, err := reader.Query(ctx, `SELECT attempt_id,agent_id,status,created_at,updated_at,started_at,report,error,manual_by,manual_at,manual_comment FROM skill_ai_review_attempts WHERE request_id=$1 ORDER BY created_at,attempt_id`, request)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AIReviewAttempt{}
	for rows.Next() {
		var item AIReviewAttempt
		var report []byte
		if err := rows.Scan(&item.AttemptID, &item.AgentID, &item.Status, &item.CreatedAt, &item.UpdatedAt, &item.StartedAt, &report, &item.Error, &item.ManualBy, &item.ManualAt, &item.ManualComment); err != nil {
			return nil, err
		}
		if len(report) > 0 {
			if err := json.Unmarshal(report, &item.Report); err != nil {
				return nil, err
			}
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func writeAIAttempts(ctx context.Context, tx pgx.Tx, request string, items []AIReviewAttempt) error {
	for _, item := range items {
		var report []byte
		if item.Report != nil {
			report, _ = json.Marshal(item.Report)
		}
		_, err := tx.Exec(ctx, `INSERT INTO skill_ai_review_attempts(attempt_id,request_id,agent_id,status,created_at,updated_at,started_at,report,error,manual_by,manual_at,manual_comment)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
ON CONFLICT(attempt_id) DO UPDATE SET status=EXCLUDED.status,updated_at=EXCLUDED.updated_at,started_at=EXCLUDED.started_at,report=EXCLUDED.report,error=EXCLUDED.error,manual_by=EXCLUDED.manual_by,manual_at=EXCLUDED.manual_at,manual_comment=EXCLUDED.manual_comment`, item.AttemptID, request, item.AgentID, item.Status, item.CreatedAt, item.UpdatedAt, item.StartedAt, report, item.Error, item.ManualBy, item.ManualAt, item.ManualComment)
		if err != nil {
			return err
		}
	}
	return nil
}

func createAIRequest(ctx context.Context, tx pgx.Tx, request, version, space string, now time.Time) error {
	_, err := tx.Exec(ctx, `INSERT INTO skill_ai_review_attempts(attempt_id,request_id,agent_id,status,created_at,updated_at)
SELECT $1,$2,c.agent_id,'pending',$5,$5 FROM skill_space_ai_review_configs c
WHERE c.space_id=$4 AND c.enabled AND EXISTS(SELECT 1 FROM approval_requests WHERE id=$2)
AND EXISTS(SELECT 1 FROM skill_versions WHERE version_id=$3 AND source_id IS NULL)`, newID("ai_attempt"), request, version, space, now)
	return err
}

func (s *PostgresStore) GetAIReviewConfig(ctx context.Context, space string) (AIReviewConfig, error) {
	var config AIReviewConfig
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(c.enabled,false),COALESCE(c.agent_id,'') FROM skill_spaces sp LEFT JOIN skill_space_ai_review_configs c ON c.space_id=sp.space_id WHERE sp.space_id=$1`, space).Scan(&config.Enabled, &config.AgentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return config, ErrSpaceNotFound
	}
	return config, err
}

func (s *PostgresStore) SetAIReviewConfig(ctx context.Context, space string, config AIReviewConfig, user string, now time.Time) (AIReviewConfig, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return AIReviewConfig{}, err
	}
	defer tx.Rollback(ctx)
	var provider string
	if err := tx.QueryRow(ctx, `SELECT approval_provider FROM skill_spaces WHERE space_id=$1 FOR UPDATE`, space).Scan(&provider); err != nil {
		return AIReviewConfig{}, mapNotFound(err)
	}
	var active bool
	if err := tx.QueryRow(ctx, `SELECT status='active' FROM accounts WHERE user_id=$1 FOR SHARE`, user).Scan(&active); err != nil || !active {
		return AIReviewConfig{}, ErrReviewForbidden
	}
	if config.Enabled {
		var configured bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$1) OR EXISTS(SELECT 1 FROM approval_config_roles WHERE scope_type='skill_space' AND scope_id=$1)`, space).Scan(&configured); err != nil {
			return AIReviewConfig{}, err
		}
		if provider != "local" || !configured {
			return AIReviewConfig{}, ErrInvalidRequest
		}
		if err := tx.QueryRow(ctx, `SELECT a.status='active' AND m.status='active' FROM account_agents owner JOIN accounts a ON a.user_id=owner.user_id JOIN mcp_agents m ON m.agent_id=owner.agent_id WHERE owner.agent_id=$1 FOR SHARE OF owner,a,m`, config.AgentID).Scan(&active); err != nil || !active {
			return AIReviewConfig{}, ErrInvalidRequest
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO skill_space_ai_review_configs(space_id,enabled,agent_id,updated_by,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(space_id) DO UPDATE SET enabled=EXCLUDED.enabled,agent_id=EXCLUDED.agent_id,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`, space, config.Enabled, config.AgentID, user, now); err != nil {
		return AIReviewConfig{}, err
	}
	return config, tx.Commit(ctx)
}

func (s *PostgresStore) listAIReviewRequests(ctx context.Context, agent string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT request_id FROM skill_ai_review_attempts WHERE agent_id=$1 AND status IN ('pending','running') ORDER BY request_id`, agent)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *PostgresStore) withAIReview(ctx context.Context, id, user string, reviewer bool, now time.Time, apply func(*aiReviewState) error) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var space, skillID, versionID string
	if err := tx.QueryRow(ctx, `SELECT r.scope_id,v.skill_id,v.version_id FROM approval_requests r JOIN skill_versions v ON v.version_id=r.business_id WHERE r.id=$1 AND r.business_type='skill_version' AND r.action='publish' AND r.scope_type='skill_space'`, id).Scan(&space, &skillID, &versionID); err != nil {
		return mapNotFound(err)
	}
	var provider string
	var configured bool
	if err := tx.QueryRow(ctx, `SELECT approval_provider,EXISTS(SELECT 1 FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$1) OR EXISTS(SELECT 1 FROM approval_config_roles WHERE scope_type='skill_space' AND scope_id=$1) FROM skill_spaces WHERE space_id=$1 FOR SHARE`, space).Scan(&provider, &configured); err != nil {
		return mapNotFound(err)
	}
	state := &aiReviewState{}
	if err := tx.QueryRow(ctx, `SELECT skill_id,space_id,name FROM skills WHERE skill_id=$1 FOR UPDATE`, skillID).Scan(&state.Skill.SkillID, &state.Skill.SpaceID, &state.Skill.Name); err != nil {
		return mapNotFound(err)
	}
	var source *string
	if err := tx.QueryRow(ctx, `SELECT version_id,skill_id,package_path,package_sha256,skill_name,description,approval_status,source_id FROM skill_versions WHERE version_id=$1 FOR UPDATE`, versionID).Scan(&state.Version.VersionID, &state.Version.SkillID, &state.Version.PackagePath, &state.Version.PackageSHA256, &state.Version.SkillName, &state.Version.Description, &state.Version.ApprovalStatus, &source); err != nil {
		return mapNotFound(err)
	}
	if err := tx.QueryRow(ctx, `SELECT id,scope_id,content_digest,status FROM approval_requests WHERE id=$1 FOR UPDATE`, id).Scan(&state.Request.ID, &state.Request.SpaceID, &state.Request.Digest, &state.Request.Status); err != nil {
		return mapNotFound(err)
	}
	var current string
	if err := tx.QueryRow(ctx, `SELECT id FROM approval_requests WHERE business_type='skill_version' AND business_id=$1 AND action='publish' AND status<>'invalidated' ORDER BY created_at DESC,id DESC LIMIT 1`, versionID).Scan(&current); err != nil {
		return ErrConflict
	}
	if current != id || provider != "local" || !configured || state.Skill.SpaceID != space || state.Request.Digest != state.Version.PackageSHA256 || state.Request.Status != "pending" || state.Version.ApprovalStatus != "pending" || source != nil {
		return ErrConflict
	}
	var allowed bool
	if err := tx.QueryRow(ctx, `SELECT status='active' AND EXISTS(SELECT 1 FROM effective_data_resource_permissions WHERE user_id=$1 AND resource_type='skill_space' AND resource_id=$2 AND action='read') FROM accounts WHERE user_id=$1 FOR SHARE`, user, space).Scan(&allowed); err != nil || !allowed {
		return ErrReviewForbidden
	}
	state.Request.AIAttempts, err = readAIAttempts(ctx, tx, id, now)
	if err != nil {
		return err
	}
	if len(state.Request.AIAttempts) == 0 {
		return ErrConflict
	}
	if reviewer {
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM approval_request_approvers WHERE request_id=$1 AND user_id=$2 AND status='pending')`, id, user).Scan(&allowed); err != nil {
			return err
		}
	} else {
		agent := state.Request.AIAttempts[len(state.Request.AIAttempts)-1].AgentID
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM account_agents owner JOIN mcp_agents m ON m.agent_id=owner.agent_id WHERE owner.user_id=$1 AND owner.agent_id=$2 AND m.status='active')`, user, agent).Scan(&allowed); err != nil {
			return err
		}
	}
	if !allowed {
		return ErrReviewForbidden
	}
	applyErr := apply(state)
	if err := writeAIAttempts(ctx, tx, id, state.Request.AIAttempts); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return applyErr
}
