package workflow

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/krillinai/Clawee/server/internal/approvals"
)

type ApprovalEvent struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Actor     string    `json:"actor"`
	ActorName string    `json:"actor_name"`
	Reason    string    `json:"reason,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

const adminApprovalRecordsSQL = `WITH records AS (
SELECT 'workflow_instance'::text AS kind,i.id,'workflow'::text AS type,wt.name AS title,'workflow'::text AS channel,
CASE WHEN i.status='running' AND t.type='approval' AND t.status='pending' THEN 'pending' ELSE i.status END AS status,i.status AS business_status,
i.started_by AS initiated_by,COALESCE(u.name,'') AS initiated_name,i.started_at AS created_at,
''::text AS space_id,''::text AS space_name,''::text AS skill_id,''::text AS version_id,''::text AS version,i.template_id,
COALESCE(t.id,'') AS task_id,COALESCE(n.node->>'title','') AS current_node,
ARRAY(SELECT a.user_id FROM workflow_task_assignees a WHERE a.task_id=t.id AND t.type='approval' AND t.status='pending' AND i.status='running' ORDER BY a.user_id) AS current_approvers,
ARRAY(SELECT COALESCE(NULLIF(au.name,''),a.user_id) FROM workflow_task_assignees a JOIN accounts au ON au.user_id=a.user_id WHERE a.task_id=t.id AND t.type='approval' AND t.status='pending' AND i.status='running' ORDER BY a.user_id) AS current_approver_names,
(SELECT count(*) FROM workflow_node_tasks done WHERE done.instance_id=i.id AND done.type='approval' AND done.status IN ('completed','rejected'))::int AS progress_completed,
(SELECT count(*) FROM jsonb_array_elements(i.template_snapshot_json) AS definitions(definition) WHERE definition->>'type'='approval')::int AS progress_total,
COALESCE((i.status='running' AND t.type='approval' AND t.status='pending' AND EXISTS (SELECT 1 FROM workflow_task_assignees a WHERE a.task_id=t.id AND a.user_id=$1)),false) AS can_process,
true AS materials_available,''::text AS content_digest
FROM workflow_instances i JOIN workflow_templates wt ON wt.id=i.template_id JOIN accounts u ON u.user_id=i.started_by
LEFT JOIN workflow_node_tasks t ON t.instance_id=i.id AND t.node_id=i.current_node_id
LEFT JOIN LATERAL (SELECT definition AS node FROM jsonb_array_elements(i.template_snapshot_json) AS definitions(definition) WHERE definition->>'node_id'=i.current_node_id LIMIT 1) n ON true
WHERE EXISTS (SELECT 1 FROM accounts actor WHERE actor.user_id=$1 AND actor.status='active')
AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.template_snapshot_json) AS definitions(definition) WHERE definition->>'type'='approval')
) `

func (s *Service) AdminApprovals(ctx context.Context, user string, filter approvals.Filter, limit int) ([]approvals.Record, error) {
	if user == "" || limit < 1 || limit > 51 {
		return nil, ErrInvalid
	}
	rows, err := s.DB.Query(ctx, adminApprovalRecordsSQL+`SELECT `+approvals.Columns+` FROM records`+approvals.FilterSQL+approvals.PageSQL, filter.PageArgs(user, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []approvals.Record{}
	for rows.Next() {
		item, err := approvals.Scan(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) AdminApprovalSummary(ctx context.Context, user string, filter approvals.Filter) (approvals.Summary, error) {
	var summary approvals.Summary
	err := s.DB.QueryRow(ctx, adminApprovalRecordsSQL+approvals.SummarySQL+approvals.FilterSQL, filter.Args(user)...).Scan(&summary.Total, &summary.Pending, &summary.Running, &summary.Abnormal)
	return summary, err
}

func (s *Service) AdminApproval(ctx context.Context, user, id string, fileAdmin ...bool) (approvals.Record, Instance, error) {
	item, err := approvals.Scan(s.DB.QueryRow(ctx, adminApprovalRecordsSQL+`SELECT `+approvals.Columns+` FROM records WHERE id=$2`, user, id))
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrMissing
	}
	if err != nil {
		return item, Instance{}, err
	}
	instance, err := s.Instance(ctx, id, user, true, fileAdmin...)
	return item, instance, err
}

func (s *Service) AdminApprovalEvents(ctx context.Context, id string) ([]ApprovalEvent, error) {
	rows, err := s.DB.Query(ctx, `SELECT e.id,e.event_type,e.actor_user_id,COALESCE(u.name,''),COALESCE(e.metadata_json->>'reason',''),e.created_at
FROM workflow_events e LEFT JOIN accounts u ON u.user_id=e.actor_user_id WHERE e.instance_id=$1 ORDER BY e.created_at,e.id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ApprovalEvent{}
	for rows.Next() {
		var item ApprovalEvent
		if err = rows.Scan(&item.ID, &item.Type, &item.Actor, &item.ActorName, &item.Reason, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
