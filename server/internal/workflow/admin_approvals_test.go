package workflow

import (
	"context"
	"errors"
	"testing"

	"github.com/krillinai/Clawee/server/internal/approvals"
)

func TestAdminApprovalsInstanceGranularityAndAgentBoundary(t *testing.T) {
	service := workflowTestService(t)
	ctx := context.Background()
	agent := enabledWorkflow(t, service, []Node{{ID: "agent", Type: "agent", Title: "执行", Assignee: "a", Instruction: "执行"}})
	agentOnly, err := service.Start(ctx, agent.ID, "a", "agent", nil)
	if err != nil {
		t.Fatal(err)
	}
	template := enabledWorkflow(t, service, []Node{{ID: "review", Type: "approval", Title: "共同审批", AssigneeUsers: []string{"a", "b"}, Instruction: "核对"}, {ID: "agent", Order: 1, Type: "agent", Title: "执行", Assignee: "c", Instruction: "执行"}})
	started, err := service.Start(ctx, template.ID, "a", "approval", nil)
	if err != nil {
		t.Fatal(err)
	}
	filter := approvals.Filter{View: "all", Status: "all", Channel: "all"}
	items, err := service.AdminApprovals(ctx, "other", filter, 20)
	if err != nil || len(items) != 1 || items[0].ID != started.InstanceID || items[0].Status != "pending" || len(items[0].CurrentApprovers) != 2 || items[0].CanProcess {
		t.Fatalf("按实例去重且不赋予处理权限: %#v %v", items, err)
	}
	if _, _, err = service.AdminApproval(ctx, "other", agentOnly.InstanceID); !errors.Is(err, ErrMissing) {
		t.Fatalf("纯 Agent 实例不能从审批详情进入: %v", err)
	}
	if _, err = service.Complete(ctx, started.TaskID, "other", "", "illegal", "approve", "越权", nil); !errors.Is(err, ErrMissing) {
		t.Fatalf("管理员查询不能绕过审批人: %v", err)
	}
	if _, err = service.Complete(ctx, started.TaskID, "b", "", "approve", "approve", "通过", nil); err != nil {
		t.Fatal(err)
	}
	items, err = service.AdminApprovals(ctx, "other", filter, 20)
	if err != nil || len(items) != 1 || items[0].Status != "running" || items[0].ProgressCompleted != 1 || items[0].ProgressTotal != 1 {
		t.Fatalf("Agent 执行阶段不能冒充待审批: %#v %v", items, err)
	}
	summary, err := service.AdminApprovalSummary(ctx, "other", filter)
	if err != nil || summary.Total != 1 || summary.Pending != 0 || summary.Running != 1 {
		t.Fatal(summary, err)
	}
	if err = service.Terminate(ctx, started.InstanceID, "a", "结束"); err != nil {
		t.Fatal(err)
	}
	filter.View = "closed"
	items, err = service.AdminApprovals(ctx, "other", filter, 20)
	if err != nil || len(items) != 1 || items[0].Status != "terminated" {
		t.Fatal(items, err)
	}
	events, err := service.AdminApprovalEvents(ctx, started.InstanceID)
	if err != nil || len(events) != 3 || events[2].Type != "instance_terminated" || events[2].Actor != "a" || events[2].Reason != "结束" {
		t.Fatalf("管理操作须保留操作者和原因: %#v %v", events, err)
	}
}
