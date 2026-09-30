package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
)

func workflowRoles(t *testing.T, s *Service) {
	t.Helper()
	_, err := s.DB.Exec(context.Background(), `INSERT INTO rbac_roles (role_id,code,name,created_at,updated_at) VALUES
		('team','workflow_team','工作流团队',now(),now()),
		('overlap','workflow_overlap','重叠团队',now(),now()),
		('empty','workflow_empty','空团队',now(),now());
		INSERT INTO account_roles (user_id,role_id,created_at) VALUES
		('a','team',now()),('b','team',now()),('b','overlap',now()),('c','overlap',now())`)
	if err != nil {
		t.Fatal(err)
	}
}

func enabledWorkflow(t *testing.T, s *Service, nodes []Node) Template {
	t.Helper()
	item, err := s.Save(context.Background(), "a", "", "共同待办", "", 0, nodes)
	if err != nil {
		t.Fatal(err)
	}
	item, err = s.SetStatus(context.Background(), item.ID, "a", true)
	if err != nil {
		t.Fatal(err)
	}
	return item
}

func TestWorkflowSharedCandidatesAndConcurrentCompletion(t *testing.T) {
	s := &Service{DB: workflowTestDB(t)}
	workflowRoles(t, s)
	ctx := context.Background()
	template := enabledWorkflow(t, s, []Node{
		{ID: "first", Order: 0, Type: "agent", Title: "执行", Instruction: "执行", Assignee: "a", AssigneeUsers: []string{"b", "a"}, AssigneeRoles: []string{"team", "overlap", "team"}, ResolvedUsers: []string{"other"}},
		{ID: "review", Order: 1, Type: "approval", Title: "审核", Instruction: "审核", AssigneeUsers: []string{"b", "c"}},
	})
	if len(template.Nodes[0].ResolvedUsers) != 0 {
		t.Fatal("保存请求中的伪造候选未清除")
	}
	started, err := s.Start(ctx, template.ID, "c", "start", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []string{"a", "b", "c"} {
		items, _, err := s.Tasks(ctx, user, "agent", 20, "")
		if err != nil || len(items) != 1 || items[0].ID != started.TaskID || !reflect.DeepEqual(items[0].AssigneeUsers, []string{"a", "b", "c"}) {
			t.Fatalf("共享待办 %s: %+v %v", user, items, err)
		}
		if _, err := s.Task(ctx, started.TaskID, user, "agent"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Instance(ctx, started.InstanceID, user, false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Task(ctx, started.TaskID, "other", ""); !errors.Is(err, ErrMissing) {
		t.Fatalf("非候选读取: %v", err)
	}
	if _, err := s.Complete(ctx, started.TaskID, "other", "agent-other", "same", "", "", nil); !errors.Is(err, ErrMissing) {
		t.Fatalf("非候选完成: %v", err)
	}
	var wait sync.WaitGroup
	ready := make(chan struct{})
	type completion struct {
		user   string
		result Result
		err    error
	}
	results := make(chan completion, 2)
	for _, user := range []string{"a", "b"} {
		wait.Add(1)
		go func(user string) {
			defer wait.Done()
			<-ready
			result, err := s.Complete(ctx, started.TaskID, user, "agent-"+user, "same", "", "", json.RawMessage(`{"done":true}`))
			results <- completion{user, result, err}
		}(user)
	}
	close(ready)
	wait.Wait()
	close(results)
	var winner completion
	succeeded, conflicted := 0, 0
	for result := range results {
		if result.err == nil {
			winner = result
			succeeded++
		} else if errors.Is(result.err, ErrConflict) {
			conflicted++
		} else {
			t.Fatal(result.err)
		}
	}
	if succeeded != 1 || conflicted != 1 || winner.result.NextTask == nil {
		t.Fatalf("完成次数: success=%d conflict=%d winner=%+v", succeeded, conflicted, winner)
	}
	if result, err := s.Complete(ctx, started.TaskID, winner.user, "agent-"+winner.user, "same", "", "", json.RawMessage(`{"done":true}`)); err != nil || result.NextTask.ID != winner.result.NextTask.ID {
		t.Fatalf("实际完成人幂等重试: %+v %v", result, err)
	}
	for _, user := range []string{"a", "b", "c"} {
		items, _, err := s.Tasks(ctx, user, "agent", 20, "")
		if err != nil || len(items) != 0 {
			t.Fatalf("待办未消失: %+v %v", items, err)
		}
		if user != winner.user {
			if _, err := s.Complete(ctx, started.TaskID, user, "agent-"+user, "same", "", "", json.RawMessage(`{"done":true}`)); !errors.Is(err, ErrConflict) {
				t.Fatalf("冒领幂等结果: %v", err)
			}
		}
	}
	instance, err := s.Instance(ctx, started.InstanceID, "c", false)
	if err != nil || len(instance.Tasks) != 2 || instance.Tasks[0].HandledBy != winner.user || !reflect.DeepEqual(instance.Nodes[0].ResolvedUsers, []string{"a", "b", "c"}) {
		t.Fatalf("节点快照/实际处理人: %+v %v", instance, err)
	}
	var events int
	if err := s.DB.QueryRow(ctx, `SELECT count(*) FROM workflow_events WHERE instance_id=$1 AND event_type='task_completed'`, started.InstanceID).Scan(&events); err != nil || events != 1 {
		t.Fatalf("流转事件次数: %d %v", events, err)
	}
	var nextTasks int
	if err := s.DB.QueryRow(ctx, `SELECT count(*) FROM workflow_node_tasks WHERE instance_id=$1 AND node_id='review'`, started.InstanceID).Scan(&nextTasks); err != nil || nextTasks != 1 {
		t.Fatalf("下一节点任务次数: %d %v", nextTasks, err)
	}
	if _, err := s.Task(ctx, winner.result.NextTask.ID, "a", "approval"); !errors.Is(err, ErrMissing) {
		t.Fatalf("实例参与人越权处理下一节点: %v", err)
	}
	rejected, err := s.Complete(ctx, winner.result.NextTask.ID, "c", "", "reject", "reject", "驳回", nil)
	if err != nil || rejected.Status != "rejected" || rejected.NextTask != nil {
		t.Fatalf("共同审核驳回: %+v %v", rejected, err)
	}
}

func TestWorkflowRoleSnapshotAndVisibility(t *testing.T) {
	s := &Service{DB: workflowTestDB(t)}
	workflowRoles(t, s)
	ctx := context.Background()
	template := enabledWorkflow(t, s, []Node{
		{ID: "first", Order: 0, Type: "agent", Title: "执行", Instruction: "执行", AssigneeRoles: []string{"team"}},
		{ID: "review", Order: 1, Type: "approval", Title: "审核", Instruction: "审核", AssigneeRoles: []string{"team"}},
	})
	old, err := s.Start(ctx, template.ID, "b", "old", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(ctx, `DELETE FROM account_roles WHERE role_id='team' AND user_id='b'; INSERT INTO account_roles(user_id,role_id,created_at) VALUES ('c','team',now())`); err != nil {
		t.Fatal(err)
	}
	for _, user := range []string{"a", "c"} {
		if _, err := s.Template(ctx, template.ID, user, false); err != nil {
			t.Fatal(err)
		}
		items, _, err := s.Templates(ctx, user, false, 20, "")
		if err != nil || len(items) != 1 {
			t.Fatalf("角色模板可见: %+v %v", items, err)
		}
	}
	for _, user := range []string{"b", "other"} {
		if _, err := s.Template(ctx, template.ID, user, false); !errors.Is(err, ErrMissing) {
			t.Fatalf("角色模板越权: %v", err)
		}
		if _, err := s.Start(ctx, template.ID, user, "denied-"+user, nil); !errors.Is(err, ErrMissing) {
			t.Fatalf("角色发起越权: %v", err)
		}
	}
	if _, err := s.Task(ctx, old.TaskID, "b", "agent"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Task(ctx, old.TaskID, "c", "agent"); !errors.Is(err, ErrMissing) {
		t.Fatalf("新成员进入历史待办: %v", err)
	}
	if _, err := s.Instance(ctx, old.InstanceID, "c", false); !errors.Is(err, ErrMissing) {
		t.Fatalf("新成员进入历史实例: %v", err)
	}
	next, err := s.Complete(ctx, old.TaskID, "b", "agent-b", "done", "", "", nil)
	if err != nil || !reflect.DeepEqual(next.NextTask.AssigneeUsers, []string{"a", "b"}) {
		t.Fatalf("未来节点未用发起快照: %+v %v", next, err)
	}
	current, err := s.Start(ctx, template.ID, "c", "new", nil)
	if err != nil {
		t.Fatal(err)
	}
	if task, err := s.Task(ctx, current.TaskID, "c", "agent"); err != nil || !reflect.DeepEqual(task.AssigneeUsers, []string{"a", "c"}) {
		t.Fatalf("新实例未展开新成员: %+v %v", task, err)
	}
	if _, err := s.DB.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE user_id='b'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Task(ctx, next.NextTask.ID, "b", "approval"); !errors.Is(err, ErrMissing) {
		t.Fatalf("禁用账号读取待办: %v", err)
	}
	if _, err := s.Complete(ctx, next.NextTask.ID, "b", "", "disabled", "approve", "", nil); !errors.Is(err, ErrMissing) {
		t.Fatalf("禁用账号完成: %v", err)
	}
}

func TestWorkflowInvalidCandidates(t *testing.T) {
	s := &Service{DB: workflowTestDB(t)}
	workflowRoles(t, s)
	ctx := context.Background()
	resolved, err := resolveNode(ctx, s.DB, Node{Assignee: "a", AssigneeUsers: []string{"b", "b"}})
	if err != nil || !reflect.DeepEqual(resolved, []string{"a", "b"}) {
		t.Fatalf("新旧账户字段并集: %v %v", resolved, err)
	}
	for _, node := range []Node{
		{AssigneeUsers: []string{"missing"}},
		{AssigneeUsers: []string{""}},
		{AssigneeRoles: []string{"missing"}},
		{Assignee: "a", AssigneeRoles: []string{"empty"}},
		{ResolvedUsers: []string{"a"}},
	} {
		node.ID, node.Type = "first", "agent"
		if _, err := s.Save(ctx, "a", "", "非法候选", "", 0, []Node{node}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("非法候选未拒绝: %+v %v", node, err)
		}
	}
	nodes := []Node{{ID: "first", Type: "agent", Title: "执行", Instruction: "执行", AssigneeRoles: []string{"team"}}}
	template := enabledWorkflow(t, s, nodes)
	if _, err := s.DB.Exec(ctx, `DELETE FROM account_roles WHERE role_id='team'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(ctx, template.ID, "a", "empty", nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("空角色发起未拒绝: %v", err)
	}
	if _, err := s.SetStatus(ctx, template.ID, "a", true); !errors.Is(err, ErrInvalid) {
		t.Fatalf("空角色启用未拒绝: %v", err)
	}
	if _, err := s.DB.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE user_id='b'`); err != nil {
		t.Fatal(err)
	}
	resolved, err = resolveNode(ctx, s.DB, Node{AssigneeRoles: []string{"overlap"}})
	if err != nil || !reflect.DeepEqual(resolved, []string{"c"}) {
		t.Fatalf("禁用角色成员未过滤: %v %v", resolved, err)
	}
	if _, err := s.Save(ctx, "a", "", "禁用负责人", "", 0, []Node{{ID: "first", Type: "agent", Assignee: "b"}}); !errors.Is(err, ErrAssignees) {
		t.Fatalf("禁用直接负责人未拒绝: %v", err)
	}
}
