package skillhub

import (
	"context"
	"strings"
	"testing"
)

func TestAIReviewTaskDisplayMetadata(t *testing.T) {
	ctx := context.Background()
	service, timeout, _ := aiTestService(t, false)
	_, approval := aiTestUpload(t, service, "1.0.0")
	check := func(attemptID string, number int) {
		t.Helper()
		tasks, err := service.ListAIReviewTasks(ctx, "runner", "agent-review")
		if err != nil {
			t.Fatal(err)
		}
		if len(tasks) != 1 || tasks[0].Version != "1.0.0" || tasks[0].AttemptNumber != number || tasks[0].AttemptID != attemptID {
			t.Fatalf("审核任务展示信息不匹配: %+v", tasks)
		}
	}
	check(approval.AIReview.AttemptID, 1)
	claimed, err := service.ClaimAIReview(ctx, approval.RequestID, "runner", "agent-review", AIReviewClaimInput{
		AttemptID: approval.AIReview.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64),
	})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Version != "1.0.0" || claimed.AttemptNumber != 1 {
		t.Fatalf("领取未保留展示信息: %+v", claimed)
	}
	timeout(approval.RequestID)
	retry, err := service.ManageAIReview(ctx, approval.RequestID, approval.AIReview.AttemptID, "writer", "", false)
	if err != nil {
		t.Fatal(err)
	}
	check(retry.AttemptID, 2)
}
