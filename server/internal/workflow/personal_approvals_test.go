package workflow

import (
	"context"
	"errors"
	"testing"
)

func TestWorkflowPersonalApprovalsOwnership(t *testing.T) {
	s := &Service{DB: workflowTestDB(t)}
	ctx := context.Background()
	template := enabledWorkflow(t, s, []Node{{ID: "approval", Type: "approval", Title: "共同审批", AssigneeUsers: []string{"a", "b"}, Instruction: "核对"}, {ID: "agent", Order: 1, Type: "agent", Title: "执行", Assignee: "c", Instruction: "执行"}})
	started, err := s.Start(ctx, template.ID, "a", "start", nil)
	if err != nil {
		t.Fatal(err)
	}
	list := func(user, view string) []ApprovalRecord {
		t.Helper()
		items, err := s.Approvals(ctx, user, ApprovalQuery{View: view, Status: "all", Limit: 20})
		if err != nil {
			t.Fatal(err)
		}
		return items
	}
	for _, user := range []string{"a", "b"} {
		if items := list(user, "todo"); len(items) != 1 || items[0].ID != started.TaskID || !items[0].CanProcess || items[0].Title != "共同审批" {
			t.Fatalf("共享候选 %s: %#v", user, items)
		}
	}
	if len(list("other", "todo")) != 0 || len(list("b", "initiated")) != 0 || len(list("a", "initiated")) != 1 {
		t.Fatal("待办与发起归属错误")
	}
	if _, _, _, err := s.Approval(ctx, "other", "workflow", started.TaskID); !errors.Is(err, ErrMissing) {
		t.Fatal(err)
	}
	if _, _, _, err := s.Approval(ctx, "b", "workflow_instance", started.InstanceID); !errors.Is(err, ErrMissing) {
		t.Fatal("非发起人不可通过我发起入口取实例", err)
	}
	completed, err := s.Complete(ctx, started.TaskID, "b", "", "decision", "approve", "通过", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(list("a", "todo")) != 0 || len(list("b", "todo")) != 0 || len(list("a", "done")) != 0 || len(list("c", "todo")) != 0 {
		t.Fatal("共享候选完成后只有真实处理人已办，agent 不得进入待办")
	}
	if items := list("b", "done"); len(items) != 1 || items[0].MyStatus != "approved" || items[0].Status != "running" || items[0].ActedAt == nil {
		t.Fatalf("实际已办: %#v", items)
	}
	item, instance, task, err := s.Approval(ctx, "b", "workflow", started.TaskID)
	if err != nil || task.HandledBy != "b" || item.CanProcess || instance.ID != started.InstanceID {
		t.Fatalf("完成详情: %#v %#v %v", item, task, err)
	}
	if _, _, _, err := s.Approval(ctx, "c", "workflow", completed.NextTask.ID); !errors.Is(err, ErrMissing) {
		t.Fatal("agent 不可成为审批详情", err)
	}
	if _, err := s.Complete(ctx, started.TaskID, "a", "", "decision", "approve", "通过", nil); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if err := s.Terminate(ctx, started.InstanceID, "a", "终止"); err != nil {
		t.Fatal(err)
	}
	if items := list("b", "done"); len(items) != 1 || items[0].Status != "terminated" {
		t.Fatal("终止不抹去已办", items)
	}
	if _, err := s.DB.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE user_id='b'`); err != nil {
		t.Fatal(err)
	}
	if len(list("b", "done")) != 0 {
		t.Fatal("停用账户不能读历史")
	}
	if _, _, _, err := s.Approval(ctx, "b", "workflow", started.TaskID); !errors.Is(err, ErrMissing) {
		t.Fatal(err)
	}
}

func TestWorkflowPersonalApprovalsExcludeAgentOnlyAndTerminated(t *testing.T) {
	s := &Service{DB: workflowTestDB(t)}
	ctx := context.Background()
	agent := enabledWorkflow(t, s, []Node{{ID: "agent", Type: "agent", Title: "执行", Assignee: "a", Instruction: "执行"}})
	if _, err := s.Start(ctx, agent.ID, "a", "agent", nil); err != nil {
		t.Fatal(err)
	}
	approval := enabledWorkflow(t, s, []Node{{ID: "approval", Type: "approval", Title: "审批", Assignee: "a", Instruction: "审批"}})
	started, err := s.Start(ctx, approval.ID, "a", "approval", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Terminate(ctx, started.InstanceID, "a", "终止"); err != nil {
		t.Fatal(err)
	}
	items, err := s.Approvals(ctx, "a", ApprovalQuery{View: "todo", Status: "all", Limit: 20})
	if err != nil || len(items) != 0 {
		t.Fatalf("终止与 agent 排除: %#v %v", items, err)
	}
	items, err = s.Approvals(ctx, "a", ApprovalQuery{View: "initiated", Status: "terminated", Limit: 20})
	if err != nil || len(items) != 1 || items[0].ID != started.InstanceID || items[0].Kind != "workflow_instance" {
		t.Fatalf("我发起只包含人工节点实例: %#v %v", items, err)
	}
}
