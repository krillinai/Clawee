package workflow

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/krillinai/Clawee/server/db/migrations"
	"github.com/pressly/goose/v3"
)

func TestWorkflowMultiAssigneesMigrationBackfillsLegacy(t *testing.T) {
	ctx := context.Background()
	s := &Service{DB: workflowTestDB(t)}
	db := stdlib.OpenDB(*s.DB.Config().ConnConfig)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.ApplyVersion(ctx, 67, false); err != nil {
		t.Fatal(err)
	}
	nodes := []Node{
		{ID: "first", Order: 0, Type: "agent", Title: "执行", Instruction: "执行", Assignee: "a"},
		{ID: "review", Order: 1, Type: "approval", Title: "审核", Instruction: "审核", Assignee: "b"},
	}
	definition, err := json.Marshal(nodes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(ctx, `INSERT INTO workflow_templates (id,name,status,definition_json,created_by,updated_by) VALUES ('legacy','旧模板','enabled',$1,'a','a')`, definition); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"pending", "completed", "rejected", "cancelled"} {
		if _, err := s.DB.Exec(ctx, `INSERT INTO workflow_instances (id,template_id,template_revision,template_snapshot_json,status,current_node_id,initial_input_json,started_by,start_key,start_digest)
			VALUES ($1,'legacy',1,$2,'running','first','{}','a',$1,'legacy')`, status, definition); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DB.Exec(ctx, `INSERT INTO workflow_node_tasks (id,instance_id,node_id,node_order,type,assignee_user_id,input_json,status) VALUES ($1,$1,'first',0,'agent','a','{}',$1)`, status); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DB.Exec(ctx, `INSERT INTO workflow_instance_participants(instance_id,user_id) VALUES ($1,'a'),($1,'b')`, status); err != nil {
			t.Fatal(err)
		}
	}
	legacyResponse, err := json.Marshal(Result{InstanceID: "completed", TaskID: "completed", Status: "running", NextTask: &Task{ID: "legacy-review", InstanceID: "completed", NodeID: "review", Order: 1, Type: "approval", Assignee: "b", Status: "pending"}})
	if err != nil {
		t.Fatal(err)
	}
	requestDigest := digest(struct {
		Decision, Comment string
		Output            json.RawMessage
	}{"", "", json.RawMessage(`{}`)})
	if _, err := s.DB.Exec(ctx, `UPDATE workflow_node_tasks SET complete_key='old-done',complete_digest=$1,complete_response_json=$2,handled_by='a' WHERE id='completed'`, requestDigest, legacyResponse); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(ctx, `INSERT INTO workflow_node_tasks(id,instance_id,node_id,node_order,type,assignee_user_id,input_json,status) VALUES ('legacy-review','completed','review',1,'approval','b','{}','pending')`); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.ApplyVersion(ctx, 67, true); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.DB.QueryRow(ctx, `SELECT count(*) FROM workflow_task_assignees WHERE user_id='a'`).Scan(&count); err != nil || count != 4 {
		t.Fatalf("历史全状态候选回填: %d %v", count, err)
	}
	if replay, err := s.Complete(ctx, "completed", "a", "agent-a", "old-done", "", "", nil); err != nil || replay.NextTask == nil || !reflect.DeepEqual(replay.NextTask.AssigneeUsers, []string{"b"}) {
		t.Fatalf("历史完成结果候选回填: %+v %v", replay, err)
	}
	instance, err := s.Instance(ctx, "pending", "b", false)
	if err != nil || !reflect.DeepEqual(instance.Nodes[1].ResolvedUsers, []string{"b"}) || !reflect.DeepEqual(instance.Tasks[0].AssigneeUsers, []string{"a"}) {
		t.Fatalf("历史当前和未来节点快照: %+v %v", instance, err)
	}
	result, err := s.Complete(ctx, "pending", "a", "agent-a", "done", "", "", nil)
	if err != nil || result.NextTask == nil || !reflect.DeepEqual(result.NextTask.AssigneeUsers, []string{"b"}) {
		t.Fatalf("历史实例继续流转: %+v %v", result, err)
	}
	if _, err := s.Task(ctx, result.NextTask.ID, "b", "approval"); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.ApplyVersion(ctx, 67, false); err != nil {
		t.Fatal(err)
	}
	var table *string
	if err := s.DB.QueryRow(ctx, `SELECT to_regclass('workflow_task_assignees')::text`).Scan(&table); err != nil || table != nil {
		t.Fatalf("Down 未删除关联表: %v %v", table, err)
	}
	if err := s.DB.QueryRow(ctx, `SELECT count(*) FROM workflow_node_tasks`).Scan(&count); err != nil || count != 6 {
		t.Fatalf("Down 改动原任务: %d %v", count, err)
	}
}
