package skillhub

import (
	"context"
	"errors"
	"testing"
)

func TestReviewWorkflowStatusFilters(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		name := "memory"
		if postgres {
			name = "postgres"
		}
		t.Run(name, func(t *testing.T) {
			service, _, _ := aiTestService(t, postgres)
			_, approval := aiTestUpload(t, service, "1")
			ctx := context.Background()
			for _, status := range []string{"", "all", "running", "succeeded", "rejected", "terminated", "error", "revision_required"} {
				items, err := service.ListReviewWorkflowRuns(ctx, "writer", ReviewWorkflowQuery{Status: status, Limit: 20})
				if err != nil {
					t.Fatal(err)
				}
				if status == "" || status == "all" || status == "running" {
					if len(items) != 1 || items[0].RequestID != approval.RequestID {
						t.Fatalf("状态 %q 应保留待 AI 评估记录: %#v", status, items)
					}
				} else if len(items) != 0 {
					t.Fatalf("状态 %q 不应匹配待 AI 评估: %#v", status, items)
				}
			}
			if _, err := service.ListReviewWorkflowRuns(ctx, "writer", ReviewWorkflowQuery{Status: "unknown", Limit: 20}); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("未知状态必须拒绝: %v", err)
			}
		})
	}
}
