package workflow

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid   = errors.New("invalid_request")
	ErrLarge     = errors.New("payload_too_large")
	ErrMissing   = errors.New("not_found")
	ErrForbidden = errors.New("forbidden")
	ErrConflict  = errors.New("conflict")
)

type Node struct {
	ID          string `json:"node_id"`
	Order       int    `json:"order"`
	Type        string `json:"type"`
	Title       string `json:"title"`
	Assignee    string `json:"assignee_user_id"`
	Instruction string `json:"instruction"`
}

type Template struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Status      string    `json:"status"`
	Revision    int       `json:"revision"`
	Nodes       []Node    `json:"nodes"`
	CreatedBy   string    `json:"created_by"`
	UpdatedBy   string    `json:"updated_by"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Task struct {
	ID          string          `json:"task_id"`
	InstanceID  string          `json:"instance_id"`
	NodeID      string          `json:"node_id"`
	Order       int             `json:"node_order"`
	Type        string          `json:"type"`
	Assignee    string          `json:"assignee_user_id"`
	Instruction string          `json:"instruction"`
	Input       json.RawMessage `json:"input"`
	Output      json.RawMessage `json:"output,omitempty"`
	Status      string          `json:"status"`
	Decision    string          `json:"decision,omitempty"`
	Comment     string          `json:"comment,omitempty"`
	HandledBy   string          `json:"handled_by,omitempty"`
	CompletedAt *time.Time      `json:"completed_at,omitempty"`
}

type Instance struct {
	ID               string            `json:"id"`
	TemplateID       string            `json:"template_id"`
	TemplateRevision int               `json:"template_revision"`
	Nodes            []Node            `json:"nodes"`
	Status           string            `json:"status"`
	CurrentNodeID    string            `json:"current_node_id,omitempty"`
	InitialInput     json.RawMessage   `json:"initial_input"`
	StartedBy        string            `json:"started_by"`
	UserNames        map[string]string `json:"user_names,omitempty"`
	StartedAt        time.Time         `json:"started_at"`
	EndedAt          *time.Time        `json:"ended_at,omitempty"`
	Tasks            []Task            `json:"tasks,omitempty"`
}

type Result struct {
	InstanceID string `json:"instance_id"`
	TaskID     string `json:"task_id"`
	Status     string `json:"status"`
	NextTask   *Task  `json:"next_task,omitempty"`
}

type Service struct{ DB *pgxpool.Pool }

func object(value json.RawMessage) (json.RawMessage, error) {
	if len(value) == 0 {
		value = json.RawMessage(`{}`)
	}
	if len(value) > 1<<20 {
		return nil, ErrLarge
	}
	var decoded map[string]json.RawMessage
	if json.Unmarshal(value, &decoded) != nil || decoded == nil {
		return nil, ErrInvalid
	}
	return value, nil
}

func digest(value any) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum)
}

func (s *Service) validate(ctx context.Context, nodes []Node, full bool) error {
	if !full && len(nodes) == 0 {
		return nil
	}
	if len(nodes) == 0 || len(nodes) > 100 {
		return ErrInvalid
	}
	seen := make(map[string]bool)
	for i, node := range nodes {
		if node.ID == "" || seen[node.ID] || node.Order != i || (node.Type != "agent" && node.Type != "approval") {
			return ErrInvalid
		}
		seen[node.ID] = true
		if !full {
			continue
		}
		if strings.TrimSpace(node.Title) == "" || strings.TrimSpace(node.Instruction) == "" || node.Assignee == "" {
			return ErrInvalid
		}
		var active bool
		if err := s.DB.QueryRow(ctx, `SELECT status = 'active' FROM accounts WHERE user_id = $1`, node.Assignee).Scan(&active); err != nil || !active {
			return ErrInvalid
		}
	}
	return nil
}

func scanTemplate(row pgx.Row) (Template, error) {
	var t Template
	var raw []byte
	err := row.Scan(&t.ID, &t.Name, &t.Description, &t.Status, &t.Revision, &raw, &t.CreatedBy, &t.UpdatedBy, &t.CreatedAt, &t.UpdatedAt)
	if err == pgx.ErrNoRows {
		return t, ErrMissing
	}
	if err != nil {
		return t, err
	}
	err = json.Unmarshal(raw, &t.Nodes)
	return t, err
}

const templateColumns = `id, name, description, status, revision, definition_json, created_by, updated_by, created_at, updated_at`

func (s *Service) Template(ctx context.Context, id, user string, admin bool) (Template, error) {
	t, err := scanTemplate(s.DB.QueryRow(ctx, `SELECT `+templateColumns+` FROM workflow_templates WHERE id = $1`, id))
	if err != nil {
		return t, err
	}
	if !admin {
		if t.Status != "enabled" {
			return Template{}, ErrMissing
		}
		for _, node := range t.Nodes {
			if node.Assignee == user {
				return t, nil
			}
		}
		return Template{}, ErrMissing
	}
	return t, nil
}

func (s *Service) Save(ctx context.Context, actor, id, name, description string, expected int, nodes []Node) (Template, error) {
	if strings.TrimSpace(name) == "" || len(name) > 128 || len(description) > 4096 || len(nodes) > 100 {
		return Template{}, ErrInvalid
	}
	if id == "" {
		if expected != 0 {
			return Template{}, ErrConflict
		}
		id = uuid.NewString()
	}
	if nodes == nil {
		nodes = []Node{}
	}
	previous, err := s.Template(ctx, id, "", true)
	if err != nil && !errors.Is(err, ErrMissing) {
		return Template{}, err
	}
	if err == nil && previous.Revision != expected {
		return Template{}, ErrConflict
	}
	if errors.Is(err, ErrMissing) && expected != 0 {
		return Template{}, ErrConflict
	}
	if err := s.validate(ctx, nodes, err == nil && previous.Status == "enabled"); err != nil {
		return Template{}, err
	}
	definition, _ := json.Marshal(nodes)
	if len(definition) > 1<<20 {
		return Template{}, ErrLarge
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Template{}, err
	}
	defer tx.Rollback(ctx)
	if expected == 0 {
		_, err = tx.Exec(ctx, `INSERT INTO workflow_templates (id,name,description,status,definition_json,created_by,updated_by) VALUES ($1,$2,$3,'draft',$4,$5,$5)`, id, name, description, definition, actor)
	} else {
		command, e := tx.Exec(ctx, `UPDATE workflow_templates SET name=$2,description=$3,definition_json=$4,revision=revision+1,updated_by=$5,updated_at=now() WHERE id=$1 AND revision=$6 AND status=$7`, id, name, description, definition, actor, expected, previous.Status)
		err = e
		if err == nil && command.RowsAffected() == 0 {
			return Template{}, ErrConflict
		}
	}
	if err != nil {
		return Template{}, err
	}
	if err = s.event(ctx, tx, id, "", "", "template_saved", actor, "", ""); err != nil {
		return Template{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Template{}, err
	}
	return s.Template(ctx, id, "", true)
}

func (s *Service) SetStatus(ctx context.Context, id, actor string, enabled bool) (Template, error) {
	t, err := s.Template(ctx, id, "", true)
	if err != nil {
		return t, err
	}
	status := "disabled"
	if enabled {
		status = "enabled"
		if err := s.validate(ctx, t.Nodes, true); err != nil {
			return Template{}, err
		}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Template{}, err
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `UPDATE workflow_templates SET status=$2,updated_by=$3,updated_at=now() WHERE id=$1 AND revision=$4 AND status=$5`, id, status, actor, t.Revision, t.Status)
	if err != nil {
		return Template{}, err
	}
	if command.RowsAffected() == 0 {
		return Template{}, ErrConflict
	}
	if err = s.event(ctx, tx, id, "", "", "template_"+status, actor, "", ""); err != nil {
		return Template{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Template{}, err
	}
	return s.Template(ctx, id, "", true)
}

// Cursor encodes the last stable (time, id) position; clients never depend on its structure.
func page(limit int, cursor string) (int, time.Time, string, error) {
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 50 {
		return 0, time.Time{}, "", ErrInvalid
	}
	if cursor == "" {
		return limit, time.Now().Add(time.Hour), "", nil
	}
	bytes, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, time.Time{}, "", ErrInvalid
	}
	var position struct {
		Time time.Time `json:"t"`
		ID   string    `json:"i"`
	}
	if json.Unmarshal(bytes, &position) != nil || position.Time.IsZero() || position.ID == "" {
		return 0, time.Time{}, "", ErrInvalid
	}
	return limit, position.Time, position.ID, nil
}

func nextCursor(at time.Time, id string) string {
	data, _ := json.Marshal(struct {
		Time time.Time `json:"t"`
		ID   string    `json:"i"`
	}{at, id})
	return base64.RawURLEncoding.EncodeToString(data)
}

func (s *Service) Templates(ctx context.Context, user string, admin bool, limit int, cursor string) ([]Template, string, error) {
	limit, at, id, err := page(limit, cursor)
	if err != nil {
		return nil, "", err
	}
	rows, err := s.DB.Query(ctx, `SELECT `+templateColumns+` FROM workflow_templates t WHERE (t.created_at,t.id)<($1,$2) AND ($3 OR (t.status='enabled' AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.definition_json) n WHERE n->>'assignee_user_id'=$4))) ORDER BY t.created_at DESC,t.id DESC LIMIT $5`, at, id, admin, user, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	items := []Template{}
	for rows.Next() {
		t, e := scanTemplate(rows)
		if e != nil {
			return nil, "", e
		}
		items = append(items, t)
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		return items, nextCursor(last.CreatedAt, last.ID), nil
	}
	return items, "", nil
}

func (s *Service) Start(ctx context.Context, templateID, user, key string, input json.RawMessage) (Result, error) {
	if key == "" || len(key) > 200 {
		return Result{}, ErrInvalid
	}
	input, err := object(input)
	if err != nil {
		return Result{}, err
	}
	requestDigest := digest(input)
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer tx.Rollback(ctx)
	// Locking the template serializes concurrent starts for this template and key.
	t, err := scanTemplate(tx.QueryRow(ctx, `SELECT `+templateColumns+` FROM workflow_templates WHERE id=$1 FOR UPDATE`, templateID))
	if err != nil {
		return Result{}, err
	}
	var savedDigest string
	var saved []byte
	err = tx.QueryRow(ctx, `SELECT start_digest,start_response_json FROM workflow_instances WHERE template_id=$1 AND started_by=$2 AND start_key=$3`, templateID, user, key).Scan(&savedDigest, &saved)
	if err == nil {
		if savedDigest != requestDigest {
			return Result{}, ErrConflict
		}
		var result Result
		_ = json.Unmarshal(saved, &result)
		return result, tx.Commit(ctx)
	}
	if err != pgx.ErrNoRows {
		return Result{}, err
	}
	visible := false
	for _, node := range t.Nodes {
		if node.Assignee == user {
			visible = true
			break
		}
	}
	if !visible {
		return Result{}, ErrMissing
	}
	if t.Status != "enabled" {
		return Result{}, ErrConflict
	}
	if len(t.Nodes) == 0 || t.Nodes[0].Assignee != user {
		return Result{}, ErrForbidden
	}
	instanceID, taskID := uuid.NewString(), uuid.NewString()
	snapshot, _ := json.Marshal(t.Nodes)
	result := Result{InstanceID: instanceID, TaskID: taskID, Status: "running"}
	response, _ := json.Marshal(result)
	_, err = tx.Exec(ctx, `INSERT INTO workflow_instances (id,template_id,template_revision,template_snapshot_json,status,current_node_id,initial_input_json,started_by,start_key,start_digest,start_response_json) VALUES ($1,$2,$3,$4,'running',$5,$6,$7,$8,$9,$10)`, instanceID, templateID, t.Revision, snapshot, t.Nodes[0].ID, input, user, key, requestDigest, response)
	if err != nil {
		return Result{}, err
	}
	participants := map[string]bool{user: true}
	for _, n := range t.Nodes {
		participants[n.Assignee] = true
	}
	for participant := range participants {
		if _, err = tx.Exec(ctx, `INSERT INTO workflow_instance_participants (instance_id,user_id) VALUES ($1,$2)`, instanceID, participant); err != nil {
			return Result{}, err
		}
	}
	if err = s.insertTask(ctx, tx, taskID, instanceID, t.Nodes[0], input); err != nil {
		return Result{}, err
	}
	if err = s.event(ctx, tx, templateID, instanceID, taskID, "instance_started", user, "", ""); err != nil {
		return Result{}, err
	}
	return result, tx.Commit(ctx)
}

func (s *Service) insertTask(ctx context.Context, tx pgx.Tx, id, instance string, node Node, input json.RawMessage) error {
	_, err := tx.Exec(ctx, `INSERT INTO workflow_node_tasks (id,instance_id,node_id,node_order,type,assignee_user_id,input_json,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`, id, instance, node.ID, node.Order, node.Type, node.Assignee, input)
	return err
}

func (s *Service) event(ctx context.Context, tx pgx.Tx, template, instance, task, kind, user, agent, metadata string) error {
	if metadata == "" {
		metadata = "{}"
	}
	query := `INSERT INTO workflow_events (id,template_id,instance_id,task_id,event_type,actor_user_id,actor_agent_id,metadata_json) VALUES ($1,NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),$5,$6,NULLIF($7,''),$8)`
	_, err := tx.Exec(ctx, query, uuid.NewString(), template, instance, task, kind, user, agent, metadata)
	return err
}

func (s *Service) Complete(ctx context.Context, id, user, agent, key, decision, comment string, output json.RawMessage) (Result, error) {
	if id == "" || key == "" || len(key) > 200 || len(comment) > 4096 {
		return Result{}, ErrInvalid
	}
	if agent == "" {
		if decision != "approve" && decision != "reject" {
			return Result{}, ErrInvalid
		}
	} else {
		if decision != "" {
			return Result{}, ErrInvalid
		}
		var err error
		output, err = object(output)
		if err != nil {
			return Result{}, err
		}
	}
	requestDigest := digest(struct {
		Decision, Comment string
		Output            json.RawMessage
	}{decision, comment, output})
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer tx.Rollback(ctx)
	var instanceID string
	if err = tx.QueryRow(ctx, `SELECT instance_id FROM workflow_node_tasks WHERE id=$1 AND assignee_user_id=$2`, id, user).Scan(&instanceID); err == pgx.ErrNoRows {
		return Result{}, ErrMissing
	}
	if err != nil {
		return Result{}, err
	}
	var snapshot []byte
	var status, templateID string
	if err = tx.QueryRow(ctx, `SELECT template_snapshot_json,status,template_id FROM workflow_instances WHERE id=$1 FOR UPDATE`, instanceID).Scan(&snapshot, &status, &templateID); err != nil {
		return Result{}, err
	}
	var task Task
	var savedDigest string
	var saved []byte
	err = tx.QueryRow(ctx, `SELECT node_id,node_order,type,input_json,status,COALESCE(complete_key,''),COALESCE(complete_digest,''),complete_response_json FROM workflow_node_tasks WHERE id=$1`, id).Scan(&task.NodeID, &task.Order, &task.Type, &task.Input, &task.Status, &task.ID, &savedDigest, &saved)
	if err != nil {
		return Result{}, err
	}
	if task.Status != "pending" {
		if task.ID == key && savedDigest == requestDigest && len(saved) > 0 {
			var result Result
			_ = json.Unmarshal(saved, &result)
			return result, tx.Commit(ctx)
		}
		return Result{}, ErrConflict
	}
	if status != "running" {
		return Result{}, ErrConflict
	}
	if (agent == "" && task.Type != "approval") || (agent != "" && task.Type != "agent") {
		return Result{}, ErrForbidden
	}
	if agent == "" && decision == "approve" {
		output = task.Input
	}
	var nodes []Node
	if err = json.Unmarshal(snapshot, &nodes); err != nil {
		return Result{}, err
	}
	result := Result{InstanceID: instanceID, TaskID: id, Status: "running"}
	taskStatus := "completed"
	event := "task_completed"
	if decision == "reject" {
		taskStatus = "rejected"
		result.Status = "rejected"
		event = "task_rejected"
	} else if task.Order+1 < len(nodes) {
		next := nodes[task.Order+1]
		nextID := uuid.NewString()
		result.NextTask = &Task{ID: nextID, InstanceID: instanceID, NodeID: next.ID, Order: next.Order, Type: next.Type, Assignee: next.Assignee, Instruction: next.Instruction, Status: "pending"}
	} else {
		result.Status = "succeeded"
	}
	response, _ := json.Marshal(result)
	_, err = tx.Exec(ctx, `UPDATE workflow_node_tasks SET output_json=$2,status=$3,decision=NULLIF($4,''),comment=$5,complete_key=$6,complete_digest=$7,complete_response_json=$8,handled_by=$9,completed_at=now() WHERE id=$1`, id, output, taskStatus, decision, comment, key, requestDigest, response, user)
	if err != nil {
		return Result{}, err
	}
	if result.NextTask != nil {
		if err = s.insertTask(ctx, tx, result.NextTask.ID, instanceID, nodes[task.Order+1], output); err != nil {
			return Result{}, err
		}
	}
	nextNode := ""
	if result.NextTask != nil {
		nextNode = result.NextTask.NodeID
	}
	_, err = tx.Exec(ctx, `UPDATE workflow_instances SET status=$2,current_node_id=NULLIF($3,''),ended_at=CASE WHEN $2='running' THEN NULL ELSE now() END WHERE id=$1`, instanceID, result.Status, nextNode)
	if err != nil {
		return Result{}, err
	}
	if err = s.event(ctx, tx, templateID, instanceID, id, event, user, agent, ""); err != nil {
		return Result{}, err
	}
	return result, tx.Commit(ctx)
}

func (s *Service) Terminate(ctx context.Context, id, user, reason string) error {
	if strings.TrimSpace(reason) == "" || len(reason) > 4096 {
		return ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var templateID, status string
	err = tx.QueryRow(ctx, `SELECT template_id,status FROM workflow_instances WHERE id=$1 FOR UPDATE`, id).Scan(&templateID, &status)
	if err == pgx.ErrNoRows {
		return ErrMissing
	}
	if err != nil {
		return err
	}
	if status != "running" {
		return ErrConflict
	}
	_, err = tx.Exec(ctx, `UPDATE workflow_node_tasks SET status='cancelled' WHERE instance_id=$1 AND status='pending'`, id)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE workflow_instances SET status='terminated',current_node_id=NULL,ended_at=now() WHERE id=$1`, id)
	if err != nil {
		return err
	}
	metadata, _ := json.Marshal(map[string]string{"reason": reason})
	if err = s.event(ctx, tx, templateID, id, "", "instance_terminated", user, "", string(metadata)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) Instance(ctx context.Context, id, user string, admin bool) (Instance, error) {
	var item Instance
	var snapshot []byte
	err := s.DB.QueryRow(ctx, `SELECT id,template_id,template_revision,template_snapshot_json,status,COALESCE(current_node_id,''),initial_input_json,started_by,started_at,ended_at FROM workflow_instances WHERE id=$1 AND ($2 OR EXISTS (SELECT 1 FROM workflow_instance_participants p WHERE p.instance_id=id AND p.user_id=$3))`, id, admin, user).Scan(&item.ID, &item.TemplateID, &item.TemplateRevision, &snapshot, &item.Status, &item.CurrentNodeID, &item.InitialInput, &item.StartedBy, &item.StartedAt, &item.EndedAt)
	if err == pgx.ErrNoRows {
		return item, ErrMissing
	}
	if err != nil {
		return item, err
	}
	if err = json.Unmarshal(snapshot, &item.Nodes); err != nil {
		return item, err
	}
	rows, err := s.DB.Query(ctx, `SELECT id,instance_id,node_id,node_order,type,assignee_user_id,input_json,output_json,status,COALESCE(decision,''),comment,COALESCE(handled_by,''),completed_at FROM workflow_node_tasks WHERE instance_id=$1 ORDER BY node_order`, id)
	if err != nil {
		return item, err
	}
	defer rows.Close()
	item.Tasks = []Task{}
	for rows.Next() {
		var t Task
		err = rows.Scan(&t.ID, &t.InstanceID, &t.NodeID, &t.Order, &t.Type, &t.Assignee, &t.Input, &t.Output, &t.Status, &t.Decision, &t.Comment, &t.HandledBy, &t.CompletedAt)
		if err != nil {
			return item, err
		}
		t.Instruction = item.Nodes[t.Order].Instruction
		item.Tasks = append(item.Tasks, t)
	}
	return item, rows.Err()
}

func (s *Service) Instances(ctx context.Context, user string, admin bool, status string, limit int, cursor string) ([]Instance, string, error) {
	limit, at, id, err := page(limit, cursor)
	if err != nil {
		return nil, "", err
	}
	if status == "" {
		status = "running"
	}
	if status != "all" && status != "running" && status != "succeeded" && status != "rejected" && status != "terminated" {
		return nil, "", ErrInvalid
	}
	rows, err := s.DB.Query(ctx, `SELECT id,template_id,template_revision,template_snapshot_json,status,COALESCE(current_node_id,''),initial_input_json,started_by,started_at,ended_at FROM workflow_instances i WHERE (i.started_at,i.id)<($1,$2) AND ($3='all' OR i.status=$3) AND ($4 OR EXISTS (SELECT 1 FROM workflow_instance_participants p WHERE p.instance_id=i.id AND p.user_id=$5)) ORDER BY i.started_at DESC,i.id DESC LIMIT $6`, at, id, status, admin, user, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	items := []Instance{}
	for rows.Next() {
		var item Instance
		var snapshot []byte
		err = rows.Scan(&item.ID, &item.TemplateID, &item.TemplateRevision, &snapshot, &item.Status, &item.CurrentNodeID, &item.InitialInput, &item.StartedBy, &item.StartedAt, &item.EndedAt)
		if err != nil {
			return nil, "", err
		}
		if err = json.Unmarshal(snapshot, &item.Nodes); err != nil {
			return nil, "", err
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		return items, nextCursor(last.StartedAt, last.ID), nil
	}
	return items, "", nil
}

func (s *Service) Tasks(ctx context.Context, user, kind string, limit int, cursor string) ([]Task, string, error) {
	limit, at, id, err := page(limit, cursor)
	if err != nil {
		return nil, "", err
	}
	rows, err := s.DB.Query(ctx, `SELECT t.id,t.instance_id,t.node_id,t.node_order,t.type,t.assignee_user_id,t.input_json,t.status,i.template_snapshot_json,t.created_at FROM workflow_node_tasks t JOIN workflow_instances i ON i.id=t.instance_id WHERE t.assignee_user_id=$1 AND t.status='pending' AND i.status='running' AND ($2='' OR t.type=$2) AND (t.created_at,t.id)<($3,$4) ORDER BY t.created_at DESC,t.id DESC LIMIT $5`, user, kind, at, id, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	items := []Task{}
	created := []time.Time{}
	for rows.Next() {
		var t Task
		var raw []byte
		var createdAt time.Time
		err = rows.Scan(&t.ID, &t.InstanceID, &t.NodeID, &t.Order, &t.Type, &t.Assignee, &t.Input, &t.Status, &raw, &createdAt)
		if err != nil {
			return nil, "", err
		}
		var nodes []Node
		if err = json.Unmarshal(raw, &nodes); err != nil {
			return nil, "", err
		}
		t.Instruction = nodes[t.Order].Instruction
		items = append(items, t)
		created = append(created, createdAt)
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	if len(items) > limit {
		items = items[:limit]
		return items, nextCursor(created[limit-1], items[len(items)-1].ID), nil
	}
	return items, "", nil
}

func (s *Service) Task(ctx context.Context, id, user, kind string) (Task, error) {
	var t Task
	var snapshot []byte
	err := s.DB.QueryRow(ctx, `SELECT t.id,t.instance_id,t.node_id,t.node_order,t.type,t.assignee_user_id,t.input_json,t.status,i.template_snapshot_json FROM workflow_node_tasks t JOIN workflow_instances i ON i.id=t.instance_id WHERE t.id=$1 AND t.assignee_user_id=$2 AND t.status='pending' AND i.status='running' AND ($3='' OR t.type=$3)`, id, user, kind).Scan(&t.ID, &t.InstanceID, &t.NodeID, &t.Order, &t.Type, &t.Assignee, &t.Input, &t.Status, &snapshot)
	if err == pgx.ErrNoRows {
		return t, ErrMissing
	}
	if err != nil {
		return t, err
	}
	var nodes []Node
	if err = json.Unmarshal(snapshot, &nodes); err != nil {
		return t, err
	}
	t.Instruction = nodes[t.Order].Instruction
	return t, nil
}
