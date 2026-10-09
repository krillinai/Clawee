package workflow

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type ApprovalQuery struct {
	View, Status, BeforeKind, BeforeID string
	BeforeTime                         time.Time
	Limit                              int
}

type ApprovalRecord struct {
	Kind, ID, Title, Status, MyStatus string
	InstanceID, TaskID, StartedBy     string
	CreatedAt                         time.Time
	ActedAt                           *time.Time
	CanProcess                        bool
}

const approvalTaskSelect = `SELECT 'workflow',t.id,COALESCE(i.template_snapshot_json::jsonb->t.node_order->>'title',''),i.status,
CASE WHEN t.handled_by=$1 AND t.decision='approve' THEN 'approved' WHEN t.handled_by=$1 AND t.decision='reject' THEN 'rejected'
WHEN t.status='pending' AND EXISTS (SELECT 1 FROM workflow_task_assignees a WHERE a.task_id=t.id AND a.user_id=$1) THEN 'pending' ELSE '' END,
i.id,t.id,i.started_by,t.created_at,CASE WHEN t.handled_by=$1 THEN t.completed_at END,
(t.status='pending' AND i.status='running' AND i.current_node_id=t.node_id AND EXISTS (SELECT 1 FROM workflow_task_assignees a WHERE a.task_id=t.id AND a.user_id=$1))
FROM workflow_node_tasks t JOIN workflow_instances i ON i.id=t.instance_id
WHERE t.type='approval' AND EXISTS (SELECT 1 FROM accounts u WHERE u.user_id=$1 AND u.status='active')
AND EXISTS (SELECT 1 FROM workflow_instance_participants p WHERE p.instance_id=i.id AND p.user_id=$1)`

const approvalInstanceSelect = `SELECT 'workflow_instance',i.id,COALESCE((SELECT name FROM workflow_templates WHERE id=i.template_id),''),i.status,'',i.id,'',i.started_by,i.started_at,NULL::timestamptz,false
FROM workflow_instances i WHERE i.started_by=$1
AND EXISTS (SELECT 1 FROM accounts u WHERE u.user_id=$1 AND u.status='active')
AND EXISTS (SELECT 1 FROM workflow_instance_participants p WHERE p.instance_id=i.id AND p.user_id=$1)
AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.template_snapshot_json::jsonb) n WHERE n->>'type'='approval')`

func scanApproval(row interface{ Scan(...any) error }, item *ApprovalRecord) error {
	return row.Scan(&item.Kind, &item.ID, &item.Title, &item.Status, &item.MyStatus, &item.InstanceID, &item.TaskID, &item.StartedBy, &item.CreatedAt, &item.ActedAt, &item.CanProcess)
}

func (s *Service) Approvals(ctx context.Context, user string, query ApprovalQuery) ([]ApprovalRecord, error) {
	if user == "" || query.Limit < 1 || query.Limit > 51 || (query.View != "todo" && query.View != "done" && query.View != "initiated") {
		return nil, ErrInvalid
	}
	at := query.BeforeTime
	if at.IsZero() {
		at = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	selectSQL, kind, timestamp, id := approvalTaskSelect, "workflow", "t.created_at", "t.id"
	if query.View == "initiated" {
		selectSQL, kind, timestamp, id = approvalInstanceSelect, "workflow_instance", "i.started_at", "i.id"
	} else if query.View == "todo" {
		selectSQL += ` AND t.status='pending' AND i.status='running' AND i.current_node_id=t.node_id AND EXISTS (SELECT 1 FROM workflow_task_assignees a WHERE a.task_id=t.id AND a.user_id=$1)`
	} else {
		selectSQL += ` AND t.handled_by=$1 AND t.decision IN ('approve','reject') AND t.status IN ('completed','rejected')`
	}
	rows, err := s.DB.Query(ctx, selectSQL+` AND ($2='all' OR $2='' OR i.status=$2)
AND (`+timestamp+`,'`+kind+`'::text COLLATE "C",`+id+` COLLATE "C")<($3,$4::text COLLATE "C",$5::text COLLATE "C")
ORDER BY `+timestamp+` DESC,`+id+` COLLATE "C" DESC LIMIT $6`, user, query.Status, at, query.BeforeKind, query.BeforeID, query.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ApprovalRecord{}
	for rows.Next() {
		var item ApprovalRecord
		if err := scanApproval(rows, &item); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) Approval(ctx context.Context, user, kind, id string) (ApprovalRecord, Instance, *Task, error) {
	var item ApprovalRecord
	selectSQL := approvalTaskSelect + ` AND t.id=$2`
	if kind == "workflow_instance" {
		selectSQL = approvalInstanceSelect + ` AND i.id=$2`
	} else if kind != "workflow" {
		return item, Instance{}, nil, ErrInvalid
	}
	if err := scanApproval(s.DB.QueryRow(ctx, selectSQL, user, id), &item); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			err = ErrMissing
		}
		return item, Instance{}, nil, err
	}
	instance, err := s.Instance(ctx, item.InstanceID, user, false)
	if err != nil {
		return item, instance, nil, err
	}
	if kind == "workflow_instance" {
		return item, instance, nil, nil
	}
	for index := range instance.Tasks {
		if instance.Tasks[index].ID == id {
			return item, instance, &instance.Tasks[index], nil
		}
	}
	return item, Instance{}, nil, ErrMissing
}
